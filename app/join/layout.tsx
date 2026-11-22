import type { Metadata } from "next";
import { routeTitle } from "@/components/routing/TitleOnlyLayout";

export const metadata: Metadata = { title: routeTitle("Join a school") };

export { TitleOnlyLayout as default } from "@/components/routing/TitleOnlyLayout";
