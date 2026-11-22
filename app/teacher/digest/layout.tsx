import type { Metadata } from "next";
import { routeTitle } from "@/components/routing/TitleOnlyLayout";

export const metadata: Metadata = { title: routeTitle("Class digest") };

export { TitleOnlyLayout as default } from "@/components/routing/TitleOnlyLayout";
