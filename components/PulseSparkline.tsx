"use client";

import { Text } from "@chakra-ui/react";
import { Sparkline } from "@/components/Sparkline";
import type { ScholarPulse } from "@/hooks/useRosterPulse";

// ── The scholar "pulse", one canonical rendering ──────────────────────────────
// A scholar's engagement pulse is shown in exactly ONE way across every teacher
// surface (the roster Now + Lately boards, the scholar-list rail, and the
// scholar detail page's Engagement tile): a Tufte word-sized engagement
// sparkline whose end-dot is the single attention marker. There is no separate
// status orb / pip — if the pulse needs to say more, it is said HERE (enrich the
// sparkline) rather than by adding a second glyph.

// Attention level for a scholar's recent trajectory. Tints the sparkline's
// end-dot (the single attention marker) and supplies its plain-language hover.
export type AttentionLevel = "concern" | "nudge" | "ok" | "idle";

export function attentionFor(pulse: ScholarPulse | undefined): {
  level: AttentionLevel;
  label: string;
} {
  if (!pulse) return { level: "idle", label: "No recent observer readings" };
  if (pulse.attentionLevel === "concern")
    return { level: "concern", label: attentionLabel(pulse) };
  if (pulse.attentionLevel === "nudge")
    return { level: "nudge", label: attentionLabel(pulse) };
  return { level: "ok", label: attentionLabel(pulse) };
}

// Build a plain-language hover explanation from the pulse — the end-dot's
// meaning in words, for a teacher who hovers the sparkline.
function attentionLabel(pulse: ScholarPulse): string {
  const parts: string[] = [];
  if (pulse.concernFlags.length > 0) {
    parts.push(`Recurring: ${pulse.concernFlags.join(", ")}`);
  }
  if (pulse.trend === "down" && pulse.trendDelta != null) {
    parts.push(`Engagement slipping (${fmtDelta(pulse.trendDelta)} pts)`);
  } else if (pulse.trend === "up" && pulse.trendDelta != null) {
    parts.push(`Engagement rising (${fmtDelta(pulse.trendDelta)} pts)`);
  }
  if (pulse.latelyEngagement != null) {
    parts.push(`Avg engagement ${pct(pulse.latelyEngagement)}`);
  }
  if (pulse.latelyOnTask != null) {
    parts.push(`on-task ${pct(pulse.latelyOnTask)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "On track lately";
}

// The end-dot is the roster's single attention marker. Its palette is
// deliberately calm — warm earth tones, not alarm red/orange — so a slipping
// scholar reads as "worth a look," not "error." On-track rows get a quiet navy
// dot; the warm hues appear only when attention is actually warranted.
export function endColorFor(level: AttentionLevel): string {
  switch (level) {
    case "concern":
      return "#cd7a60"; // calm clay
    case "nudge":
      return "#e3b268"; // warm sand
    case "ok":
      return "var(--chakra-colors-navy-500)";
    default:
      return "var(--chakra-colors-charcoal-400)";
  }
}

export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

// Signed percentage-points delta, e.g. 0.12 → "+12", -0.08 → "−8".
export function fmtDelta(delta: number): string {
  const pts = Math.round(delta * 100);
  if (pts > 0) return `+${pts}`;
  if (pts < 0) return `−${Math.abs(pts)}`;
  return "0";
}

export interface PulseSparklineProps {
  pulse: ScholarPulse | undefined;
  /** For the aria-label. */
  scholarName?: string | null;
  /** Render the latest engagement number beside the line. */
  showValue?: boolean;
  width?: number;
  height?: number;
}

/**
 * The one canonical scholar-pulse component. Renders the engagement sparkline
 * with its attention-tinted end-dot (and a soft halo when there is concern),
 * or a quiet "—" when there are no readings yet.
 */
export function PulseSparkline({
  pulse,
  scholarName,
  showValue = true,
  width,
  height,
}: PulseSparklineProps) {
  const attn = attentionFor(pulse);

  if (!pulse || pulse.sparkline.length === 0) {
    return (
      <Text
        fontFamily="heading"
        fontSize="xs"
        color="charcoal.200"
        aria-label={`${scholarName || "Scholar"}: no engagement readings yet`}
      >
        —
      </Text>
    );
  }

  return (
    <Sparkline
      values={pulse.sparkline}
      endColor={endColorFor(attn.level)}
      endHalo={attn.level === "concern"}
      showValue={showValue}
      valueColor={endColorFor(attn.level)}
      title={attn.label}
      width={width}
      height={height}
      ariaLabel={`${scholarName || "Scholar"} engagement, latest ${
        pulse.latestEngagement != null ? pct(pulse.latestEngagement) : "—"
      } — ${attn.label}`}
    />
  );
}
