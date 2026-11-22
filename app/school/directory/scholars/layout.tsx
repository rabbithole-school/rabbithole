import type { Metadata } from "next";
import { routeTitle } from "@/components/routing/TitleOnlyLayout";

export const metadata: Metadata = { title: routeTitle("Scholar directory") };

export { TitleOnlyLayout as default } from "@/components/routing/TitleOnlyLayout";
