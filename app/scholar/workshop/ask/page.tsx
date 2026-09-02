"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Box } from "@chakra-ui/react";
import { ScholarPrepShell } from "@/components/ScholarPrepShell";
import { ScholarReflectionChat } from "@/components/ScholarReflectionChat";

function AskRabbitholeBody() {
  const params = useSearchParams();
  const seedText = params.get("seed");
  const nonce = Number(params.get("n"));
  const seed =
    seedText != null && seedText !== ""
      ? { text: seedText, nonce: Number.isFinite(nonce) ? nonce : 1 }
      : null;

  return (
    <Box h="full" bg="white">
      <ScholarReflectionChat purpose="introspection" seed={seed} />
    </Box>
  );
}

export default function AskRabbitholePage() {
  return (
    <ScholarPrepShell title="Ask Rabbithole" backHref="/scholar/workshop">
      <Suspense fallback={null}>
        <AskRabbitholeBody />
      </Suspense>
    </ScholarPrepShell>
  );
}
