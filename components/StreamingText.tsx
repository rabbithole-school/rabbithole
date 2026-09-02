"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { advanceReveal, segmentParagraphs } from "@/shared/streamingInk";

// Smooth streaming reveal (web renderer) — the "buffering" half of native's
// wet-ink typewriter, WITHOUT the wet-ink fade. Network tokens arrive in bursts
// (and the server buffers to sentence boundaries — a child-safety guard); the
// shared leaky bucket (advanceReveal) releases them ~one char at a time at a
// steady ~60 cps, decoupling the display cadence from the choppy network
// cadence — a smooth typewriter at any chunk size. Rendered as PLAIN SOLID text
// (one text node per paragraph, so kerning/wrapping stay clean).
//
// Handoff to the settled render (markdown) happens IN PLACE: once the stream is
// `done` and the reveal has caught up to the full text, this same mounted
// component renders `settled` instead of the plain paragraphs. Keeping ONE
// component mounted across the whole message lifecycle is what avoids the
// unmount/remount flash (bubble disappearing then reappearing) at stream end —
// the caller must NOT swap StreamingText out for a separate markdown node.
//
// (Native additionally fades each fresh char "wet → dry"; that visual is
// deferred on web — it needs per-surface tuning and is low bang-for-buck. The
// cadence engine, shared/streamingInk.ts, is the same on both surfaces.)

export function StreamingText({
  content,
  done = false,
  settled,
}: {
  content: string;
  /** True once the network stream is finished (drains the bucket briskly). */
  done?: boolean;
  /**
   * The final rendered content (e.g. <MarkdownBlock/>). Rendered in place of the
   * plain reveal once `done` and the reveal has caught up — so the same mounted
   * component transitions plain → markdown with no unmount flash. When omitted
   * (or while still revealing), the plain paragraphs show.
   */
  settled?: ReactNode;
}) {
  const released = useRef(0); // leaky-bucket level: chars released so far (float)
  const prevLen = useRef(0);
  const firstRun = useRef(true);
  const rafRef = useRef<number | null>(null);
  const [shown, setShown] = useState<number>(() => (done ? content.length : 0));

  useEffect(() => {
    const len = content.length;
    if (len < prevLen.current) {
      // Content replaced (new message) — reset the bucket.
      released.current = 0;
    }
    prevLen.current = len;
    // Already-complete (or empty) on first mount → show it all immediately.
    if (firstRun.current && (done || len === 0)) {
      released.current = len;
    }
    firstRun.current = false;

    const step = () => {
      const total = content.length;
      released.current = advanceReveal(released.current, total, done);
      setShown(Math.min(total, Math.floor(released.current)));
      rafRef.current = released.current < total ? requestAnimationFrame(step) : null;
    };
    step(); // paint one frame now so we don't wait a frame to start
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [content, done]);

  // Hand off to the settled (markdown) render in place, once the stream is done
  // and the reveal has caught up to the full text. `content.length > 0` guards
  // the brief window where the SSE `done` has landed but Convex hasn't yet
  // pushed the persisted message content — the caller bridges `content` so it
  // stays non-empty, but this is belt-and-suspenders so we never flash empty
  // markdown.
  if (settled != null && done && shown >= content.length && content.length > 0) {
    return <>{settled}</>;
  }

  // Split the revealed prefix into paragraph blocks so the inter-paragraph gap
  // is a stable margin matching `.chat-markdown p` (globals.css: 0.5rem, none on
  // the last) — so streaming → settled <MarkdownBlock/> never shifts vertically.
  const paras = segmentParagraphs(content.slice(0, shown));
  const lastIdx = paras.length - 1;
  return (
    <>
      {paras.map((p, idx) => (
        <div
          key={idx}
          style={{
            marginBottom: idx < lastIdx ? "0.5rem" : 0,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {p.text}
        </div>
      ))}
    </>
  );
}
