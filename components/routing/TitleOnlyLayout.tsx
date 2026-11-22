import type { Metadata } from "next";
import type { ReactNode } from "react";

/** Every route names itself first: "Screen time · Rabbithole". */
export const APP_TITLE_TEMPLATE = "%s · Rabbithole";

/**
 * A route segment's browser-tab title. It re-declares the template on purpose:
 * Next applies a title template only to the segments directly under the layout
 * that declares it, so a plain string here would drop the " · Rabbithole"
 * suffix from every nested route (/scholar/<id> under /scholar).
 */
export function routeTitle(name: string): Metadata["title"] {
  return { default: name, template: APP_TITLE_TEMPLATE };
}

/**
 * The default export for a `layout.tsx` that exists only to give a route its
 * browser-tab title. Most pages here are client components, which cannot
 * export `metadata`, so the title lives in a sibling server layout:
 *
 *   export const metadata: Metadata = { title: routeTitle("Screen time") };
 *   export { TitleOnlyLayout as default } from "@/components/routing/TitleOnlyLayout";
 *
 * A client `document.title` effect is not a substitute: on a client
 * navigation Next re-applies route metadata after the page's effects run.
 */
export function TitleOnlyLayout({ children }: { children: ReactNode }) {
  return children;
}
