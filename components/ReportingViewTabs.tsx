"use client";

/**
 * The reporting-surface view toggle: Course narratives ⇄ Whole Child.
 *
 * These are two views of the same reporting period, but with different
 * cardinality — a scholar has several course narratives (one per subject) and
 * exactly one Whole Child narrative — so each view keeps its own paradigm
 * (create-and-pick vs. roster-fill). This toggle just makes switching between
 * them a first-class, consistent move instead of a lone link buried in the
 * action row.
 *
 * Real `<a href>` links (via ViewToggle's link-mode), active state derived from
 * the URL — the house rule for anything that changes route/view (see
 * TeacherNavTabs): cmd/middle-click, copy-link, and prefetch all keep working.
 */
import { useRouter, usePathname } from "next/navigation";
import { NotePencil, UsersThree } from "@phosphor-icons/react";
import { ViewToggle } from "@/components/ui/ViewToggle";

const TABS = [
  { href: "/teacher/report", label: "Course narratives", Icon: NotePencil, match: /^\/teacher\/report/ },
  { href: "/teacher/whole-child", label: "Whole Child", Icon: UsersThree, match: /^\/teacher\/whole-child/ },
] as const;

export function ReportingViewTabs() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const activeHref = TABS.find((t) => t.match.test(pathname))?.href ?? TABS[0].href;
  return (
    <ViewToggle
      ariaLabel="Reporting view"
      value={activeHref}
      hrefFor={(href) => href}
      onChange={(href) => router.push(href)}
      items={TABS.map(({ href, label, Icon }) => ({
        value: href,
        label,
        icon: <Icon size={14} weight={activeHref === href ? "fill" : "regular"} />,
      }))}
    />
  );
}
