import type { Metadata } from "next";
import { routeTitle } from "@/components/routing/TitleOnlyLayout";
import { parentTabLabel, parentVisibleTabs, type ParentTab } from "@/components/parent/parentTabs";

// Tabs an enrolled family can open by URL: the tab row, plus Settings and
// Admissions from the account menu (parentTabFromPath, "family" mode).
const FAMILY_TABS: readonly ParentTab[] = [...parentVisibleTabs("family"), "admissions", "settings"];

// Each portal tab names itself in the browser tab ("Math Skills · Rabbithole").
// The server can't see the portal mode, so a missing or hidden segment, which
// the page resolves by mode (Home for a family, Records for a program guest),
// gets the neutral "Family portal" rather than guessing a tab. An
// applicant-only family's Admissions tab is re-titled with the school's name
// by the page.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ tab?: string[] }>;
}): Promise<Metadata> {
  const segment = (await params).tab?.[0];
  const tab = FAMILY_TABS.find((t) => t === segment);
  return { title: routeTitle(tab ? parentTabLabel(tab) : "Family portal") };
}

export { TitleOnlyLayout as default } from "@/components/routing/TitleOnlyLayout";
