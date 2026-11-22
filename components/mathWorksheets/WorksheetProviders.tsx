"use client";

import { ChakraProvider } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { EmotionRegistry } from "@/app/EmotionRegistry";
import { system } from "@/lib/theme";

/**
 * The only provider the worksheet pages need: Chakra, for the problem text
 * renderers they share with practice (StemText, FractionText). No Convex
 * client, no sign-in, no app-wide gates; those live in app/providers.tsx,
 * which these routes skip (lib/lightPublicRoutes.ts).
 */
export function WorksheetProviders({ children }: { children: ReactNode }) {
  return (
    <EmotionRegistry>
      <ChakraProvider value={system}>{children}</ChakraProvider>
    </EmotionRegistry>
  );
}
