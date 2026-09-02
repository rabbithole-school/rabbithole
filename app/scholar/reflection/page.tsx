"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Box } from "@chakra-ui/react";
import { ScholarPrepShell } from "@/components/ScholarPrepShell";
import { ScholarReflectionChat } from "@/components/ScholarReflectionChat";

/**
 * The reflection view — "Today's wrap-up" chat alone (the shipped ScholarReflectionChat,
 * reused as-is). Reached from the Scholar's-Prep chooser plainly, or from a
 * Workshop chip carrying a seed (`?seed=<phrase>&n=<nonce>`) that pre-fills the
 * composer. Back returns to the chooser. review/prep-time-chooser.html.
 */
function ReflectionPageBody() {
  const params = useSearchParams();
  const fromPrep = params.get("from") === "prep";
  const seedText = params.get("seed");
  // The nonce lets re-tapping the same chip re-seed (ScholarReflectionChat compares it);
  // a fresh `n` arrives with every chip tap that navigates here.
  const nonce = Number(params.get("n"));
  const seed =
    seedText != null && seedText !== ""
      ? { text: seedText, nonce: Number.isFinite(nonce) ? nonce : 1 }
      : null;

  return (
    <ScholarPrepShell
      title="Today's reflection"
      backHref={fromPrep ? "/scholar?tab=prep" : "/scholar"}
      preferBackHref={fromPrep}
    >
      <Box h="full" bg="white">
        <ScholarReflectionChat seed={seed} />
      </Box>
    </ScholarPrepShell>
  );
}

export default function ScholarReflectionPage() {
  return (
    <Suspense fallback={null}>
      <ReflectionPageBody />
    </Suspense>
  );
}
