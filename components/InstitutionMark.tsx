"use client";

// The single institution identity mark. It renders a school's mark through ONE
// fallback chain — uploaded logo → emoji → the name's initial — so that "emoji
// is only ever a fallback for the logo" is true everywhere by construction,
// never per-call-site. Every surface that shows a school mark (School Settings,
// the account-menu institution rows, admin scope pickers) renders through this
// component; if a school uploads a logo it wins
// automatically at all of them.
//
// Deliberately framework-light (plain elements + inline styles, no Chakra) so
// it also works in restricted embeds, which avoids extra dependencies.

import type { CSSProperties } from "react";

export interface InstitutionMarkInput {
  /** Serving URL of the uploaded logo image, when the school has one. */
  logoUrl?: string | null;
  /** The fallback emoji glyph, shown only when there is no logo. */
  emoji?: string | null;
  /** The institution name — its initial is the last-resort text fallback. */
  name?: string | null;
}

export type InstitutionMarkResolution =
  | { kind: "logo"; src: string }
  | { kind: "emoji"; glyph: string }
  | { kind: "text"; text: string };

/**
 * The fallback chain, resolved ONCE. Pure (no DOM) so the ordering is
 * unit-testable: a logo url wins; else a non-empty emoji; else the name's
 * initial (uppercased, surrogate-pair safe), or "?" when even the name is empty.
 */
export function resolveInstitutionMark(
  input: InstitutionMarkInput,
): InstitutionMarkResolution {
  const logo = input.logoUrl?.trim();
  if (logo) return { kind: "logo", src: logo };

  const emoji = input.emoji?.trim();
  if (emoji) return { kind: "emoji", glyph: emoji };

  const name = input.name?.trim();
  const initial = name ? [...name][0]!.toUpperCase() : "?";
  return { kind: "text", text: initial };
}

export interface InstitutionMarkProps extends InstitutionMarkInput {
  /** Rendered box size — a number (px) or any CSS length (e.g. "6vw"). */
  size?: number | string;
  /** Round the logo image's corners. Default true. */
  rounded?: boolean;
  style?: CSSProperties;
  className?: string;
}

const asLen = (v: number | string) => (typeof v === "number" ? `${v}px` : v);

export function InstitutionMark({
  logoUrl,
  emoji,
  name,
  size = 24,
  rounded = true,
  style,
  className,
}: InstitutionMarkProps) {
  const mark = resolveInstitutionMark({ logoUrl, emoji, name });
  const len = asLen(size);
  const label = name?.trim() || "School";

  if (mark.kind === "logo") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a Convex storage URL, sized in caller units (incl. vw); next/image adds no value for a small mark.
      <img
        src={mark.src}
        alt={`${label} logo`}
        className={className}
        style={{
          width: len,
          height: len,
          objectFit: "contain",
          borderRadius: rounded ? "18%" : undefined,
          flex: "0 0 auto",
          display: "block",
          ...style,
        }}
      />
    );
  }

  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: len,
    height: len,
    lineHeight: 1,
    flex: "0 0 auto",
  };

  if (mark.kind === "emoji") {
    return (
      <span
        className={className}
        role="img"
        aria-label={label}
        style={{ ...base, fontSize: len, ...style }}
      >
        {mark.glyph}
      </span>
    );
  }

  // Text fallback: the school's initial in a neutral rounded tile.
  return (
    <span
      className={className}
      aria-label={label}
      style={{
        ...base,
        fontSize: `calc(${len} * 0.6)`,
        fontWeight: 700,
        borderRadius: "22%",
        background: "rgba(0,0,0,0.06)",
        color: "#334155",
        ...style,
      }}
    >
      {mark.text}
    </span>
  );
}
