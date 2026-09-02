"use client";

/**
 * useEnsuredClosure — the client half of the governed closure-line generation
 * (convex/closureLines.ts). Given the SAME redacted signal the deterministic
 * builder uses, it fires ensureClosureLine ONCE (per distinct signal), and
 * returns the generated line when it arrives — or null until then.
 *
 * The caller ALWAYS renders `generated ?? deterministicFallback`, so nothing
 * ever blocks on the model: the growth line paints instantly from the shared
 * builder and only swaps to the richer generated phrasing when it's ready (and
 * from then on it's cached, so it's instant next time).
 *
 * `signal` may be null (loading / a day with nothing to say / a teacher's remote
 * view) — the hook then does nothing.
 */

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  closureSignalHash,
  type ClosureKind,
  type ClosureSignal,
} from "@/shared/closureLines";

export function useEnsuredClosure(
  scholarId: Id<"users"> | undefined,
  kind: ClosureKind,
  signal: ClosureSignal | null,
  enabled = true,
): string | null {
  const ensure = useAction(api.closureLines.ensureClosureLine);
  const [line, setLine] = useState<string | null>(null);
  // Re-fire only when the signal's identity actually changes.
  const key = signal ? closureSignalHash(kind, signal) : null;
  const firedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !scholarId || !signal || !key) return;
    if (firedKey.current === key) return;
    firedKey.current = key;
    // A new signal → drop the previous signal's generated line so the caller
    // falls back to the deterministic builder (which always matches the current
    // signal) until the fresh line resolves, rather than showing a stale hero
    // over refreshed receipts.
    setLine(null);
    let alive = true;
    ensure({ scholarId, kind, signal })
      .then((result) => {
        if (alive && result) setLine(result);
      })
      .catch(() => {
        /* keep the deterministic fallback */
      });
    return () => {
      alive = false;
    };
  }, [enabled, scholarId, kind, key, signal, ensure]);

  return line;
}
