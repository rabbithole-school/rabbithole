"use client";

/**
 * useOfferLedger — system-only "shown → accepted/declined" telemetry for a
 * done-screen offer slot (`practiceOfferEvents`). Each component INSTANCE gets
 * its own ledger: `shown(kind)` writes once per kind per mount (a render retry
 * reuses the same clientEventId, so the server dedupes too), and `settle(kind,
 * outcome)` closes it. Pass `enabled=false` for teacher remote / rehearsal —
 * nothing is written. Fire-and-forget: telemetry must never break the offer.
 * Native twin: native/src/hooks/useOfferLedger.ts.
 */

import { useCallback, useMemo, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { makeClientEventId } from "@/shared/practiceLoop";

export type OfferLedgerKind = "reprobe" | "tuneup" | "stretch" | "challenge" | "moreOfPick";

export function useOfferLedger(enabled: boolean) {
  const recordShown = useMutation(api.practiceOfferEvents.recordOfferShown);
  const recordOutcome = useMutation(api.practiceOfferEvents.recordOfferOutcome);
  const ids = useRef(new Map<OfferLedgerKind, string>());

  const shown = useCallback(
    (kind: OfferLedgerKind) => {
      if (!enabled || ids.current.has(kind)) return;
      const clientEventId = makeClientEventId("offer");
      ids.current.set(kind, clientEventId);
      void recordShown({ kind, clientEventId }).catch(() => {});
    },
    [enabled, recordShown],
  );

  const settle = useCallback(
    (kind: OfferLedgerKind, outcome: "accepted" | "declined") => {
      const clientEventId = ids.current.get(kind);
      if (!enabled || !clientEventId) return;
      void recordOutcome({ clientEventId, outcome }).catch(() => {});
    },
    [enabled, recordOutcome],
  );

  return useMemo(() => ({ shown, settle }), [shown, settle]);
}
