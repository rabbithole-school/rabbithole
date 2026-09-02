/**
 * useEnsuredClosure (native) — the RN twin of web hooks/useEnsuredClosure.ts.
 * Given the SAME redacted signal the deterministic builder uses, it fires
 * ensureClosureLine ONCE per distinct signal and returns the governed generated
 * line when it arrives (else null). The caller always renders
 * `generated ?? deterministicFallback`, so the growth line paints instantly from
 * the vendored builder and only swaps to the richer generated phrasing when
 * ready (cached thereafter).
 *
 * `signal` may be null (loading / nothing to say / a non-self view) — the hook
 * then does nothing.
 */

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api, type Id } from "@/lib/convex";
import {
  closureSignalHash,
  type ClosureKind,
  type ClosureSignal,
} from "../../vendor/shared/closureLines";

export function useEnsuredClosure(
  scholarId: Id<"users"> | undefined,
  kind: ClosureKind,
  signal: ClosureSignal | null,
  enabled = true,
): string | null {
  const ensure = useAction(api.closureLines.ensureClosureLine);
  const [line, setLine] = useState<string | null>(null);
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
