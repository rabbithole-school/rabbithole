import type { Metadata } from "next";
import { routeTitle } from "@/components/routing/TitleOnlyLayout";

export const metadata: Metadata = { title: routeTitle("Your Map") };

export { TitleOnlyLayout as default } from "@/components/routing/TitleOnlyLayout";
