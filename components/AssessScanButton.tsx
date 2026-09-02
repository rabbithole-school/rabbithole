"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button, Spinner } from "@chakra-ui/react";
import { Sparkle } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";

/**
 * "Assess with AI" — runs a multimodal assessment of a scanned deliverable
 * (Claude reads the actual image/PDF) and writes verdicts + a mastery
 * observation. The verdict pip updates reactively when it finishes. The
 * teacher's manual grade stays available as an override.
 */
export function AssessScanButton({
  deliverableId,
  label = "Assess with AI",
}: {
  deliverableId: Id<"deliverables">;
  label?: string;
}) {
  const assess = useAction(api.deliverableAssess.assessScan);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await assess({ deliverableId });
      toaster.success({
        title: "Assessed",
        description: `${r.conceptLabel} — ${r.overall === "full" ? "Full" : r.overall === "half" ? "Partial" : "Not yet"}`,
      });
    } catch (e) {
      toaster.error({
        title: "Assessment failed",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="2xs"
      variant="ghost"
      color="violet.500"
      _hover={{ bg: "violet.50" }}
      fontFamily="heading"
      fontWeight="600"
      disabled={busy}
      onClick={run}
      title={label || "Assess with AI"}
    >
      {busy ? <Spinner size="xs" /> : <Sparkle size={13} weight="fill" />}
      {label}
    </Button>
  );
}
