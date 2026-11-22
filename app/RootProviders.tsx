"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isLightPublicPath } from "@/lib/lightPublicRoutes";

/**
 * The root layout's one client boundary. App routes get the full Providers
 * (Convex, auth, Chakra, the app-wide gates). The light public routes in
 * lib/lightPublicRoutes.ts get none of it.
 *
 * Providers is loaded with next/dynamic so its code (the Convex client, the
 * sign-in code, Chakra) sits in its own chunk. A route that renders it gets that
 * chunk preloaded during server rendering; a light route never renders it, so
 * its HTML never asks for it.
 */
const Providers = dynamic(() => import("./providers").then((m) => m.Providers));

export function RootProviders({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isLightPublicPath(pathname)) return <>{children}</>;
  return <Providers>{children}</Providers>;
}
