"use client";

/**
 * The staff top-nav (Schedule · Scholars · Units · Math · Quests · Apps ·
 * Reports · School · Messages) — the SINGLE source of truth for the
 * nav's items, per-role key filtering, and styling.
 *
 * There is deliberately NO "Today" item: the logo to the left of this strip is
 * a link to `/`, which already resolves to each staff role's home — and for
 * every role that had a Today tab, that home IS Today (`/teacher`). A labelled
 * tab pointing at the page the logo already reaches is the same destination
 * rendered twice, so the strip carries only the sections the logo can't.
 *
 * There is deliberately NO "Chat" item either, for the same reason: the Robot
 * in the staff header already opens/closes the chat on whatever surface you're
 * standing on (a tool, not a place), and the dock header's labelled "All chats"
 * link is the door to the full-screen route (`lib/teacherChat.ts`). A tab beside
 * them was a third control for the one surface — and the widest label in the
 * strip. The route itself is untouched.
 *
 * It renders REAL LINKS (`<a href>`), not Ark `Tabs`. That matters:
 *  - Ark Tabs models in-page panel *selection*, not navigation — using it for
 *    routing both reads wrong to AT (a `tablist` implies panels) AND drops link
 *    affordances. This nav changes the view/route, so it's a `<nav>` of links.
 *  - Real anchors give cmd/ctrl/middle-click → open in new tab, right-click →
 *    copy link, and hover URL preview, for free from the browser.
 *
 * Plain left-clicks are intercepted (preventDefault) and delegated to
 * `onNavigate`, so each surface keeps its own soft-nav mechanism — both the
 * dashboard layout and the detail subroutes `router.push` to the target route
 * now that every section is a real route (`/teacher/<tab>`). (The dashboard
 * used to need `history.pushState` because its live Convex subscriptions
 * starved router.push transitions; the nested-routes refactor scopes those
 * heavy subscriptions out of the persistent layout, so a router transition is
 * safe again.) Modified clicks fall through to the `href` so the browser opens
 * a new tab. Active state is derived from the URL (`activeKey`), the way a nav
 * should be.
 */
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConvex } from "convex/react";
import type { ConvexReactClient } from "convex/react";
import { CalendarBlank, RocketLaunch, Users, Book, ChatsCircle, NotePencil, TreeStructure, AppWindow, Bank } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { isTeacherRole, ROLES, type Role } from "@/convex/lib/roles";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { TopNavTabs } from "@/components/ui/TopNavTabs";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export const TEACHER_NAV = [
  { key: "schedule", label: "Schedule", icon: CalendarBlank },
  { key: "scholars", label: "Scholars", icon: Users },
  { key: "curriculum", label: "Units", icon: Book },
  // The studio currently covers only math; the key/route stay `math-skills`
  // even though the label is now just "Math". Adding other subjects later
  // would need a route rename.
  { key: "math-skills", label: "Math", icon: TreeStructure },
  { key: "quests", label: "Quests", icon: RocketLaunch },
  { key: "apps", label: "Apps", icon: AppWindow },
  { key: "report", label: "Reports", icon: NotePencil },
  // School — institution administration (`/school`), a peer top-level
  // destination rather than an account-menu entry. It is the only item whose
  // route leaves the `/teacher` tree: it opens its own shell, which renders
  // this same strip (School lit) plus its own left rail of school sections.
  { key: "school", label: "School", icon: Bank },
  // Messages is always the final tab for every role that can access it.
  { key: "messages", label: "Messages", icon: ChatsCircle },
] as const;

export type TeacherNavKey = (typeof TEACHER_NAV)[number]["key"];

/** Which sections a staff role may reach. The single source of truth for BOTH
 *  shells that render this nav — the teacher dashboard layout (which also uses
 *  it for its forbidden-tab route guard) and the school shell — so a role never
 *  sees a different strip depending on which one it is standing in.
 *
 *  Chat is absent by design, not by restriction: every role listed here keeps
 *  the same chat access it had through the former tab, via the header Robot
 *  (both shells render it) and the dock's "All chats" link. */
export function teacherNavKeysForRole(
  role: Role | string | undefined,
  hasCurriculumAccess = false,
  hasProgramPublishingAccess = false,
  hasSchoolOperationsAccess = false,
): TeacherNavKey[] {
  // Every role that reaches either shell is staff, and every staff role may
  // enter `/school` (the school shell then filters its own left rail per role),
  // so School is in all three lists.
  if (role === ROLES.CURRICULUM_DESIGNER) {
    return [
      ...(hasCurriculumAccess && hasProgramPublishingAccess
        ? (["schedule"] as const)
        : []),
      "curriculum",
      "math-skills",
      "school",
    ];
  }
  if (role === "staff") {
    return [
      ...(hasProgramPublishingAccess && hasCurriculumAccess
        ? (["schedule"] as const)
        : []),
      ...(hasSchoolOperationsAccess ? (["scholars"] as const) : []),
      ...(hasCurriculumAccess ? (["curriculum"] as const) : []),
      "apps",
      "school",
      ...(hasSchoolOperationsAccess ? (["messages"] as const) : []),
    ];
  }
  return [
    "schedule",
    "scholars",
    "curriculum",
    "math-skills",
    "quests",
    "apps",
    "report",
    "school",
    "messages",
  ];
}

/** The canonical href for a teacher section — each is its own nested route
 *  (`/teacher/<tab>`). Used for the anchor's `href` (so cmd-click opens the
 *  right place) and by `router.push` soft-nav. */
export function teacherNavHref(key: TeacherNavKey): string {
  // School is its own top-level shell, not a `/teacher` subroute.
  if (key === "school") return "/school";
  return `/teacher/${key}`;
}

/** Derive the active staff section from a `/teacher/<section>/…` pathname. */
export function activeTeacherNavKeyFromPathname(
  pathname: string,
): TeacherNavKey | undefined {
  const segment = pathname.split("/")[2];
  if (segment === "whole-child") return "report";
  return TEACHER_NAV.some(
    (item) =>
      item.key === segment &&
      teacherNavHref(item.key) === `/teacher/${segment}`,
  )
    ? (segment as TeacherNavKey)
    : undefined;
}

/** `teacherNavHref` carrying the active institution lens (`?inst=`), so the
 *  school a staff member is looking at survives every hop through the strip.
 *  Used for both the anchor `href` and the soft-nav push. */
export function teacherNavHrefWithScope(
  key: TeacherNavKey,
  scopeParam: string | null | undefined,
): string {
  // The school shell is always scoped to ONE institution — it has no "all
  // institutions" state (the account menu's lens hides "All" there, and
  // SchoolInstitutionSelect rewrites `all` to a real school on arrival). So
  // drop an `all` lens on the way in rather than emitting a link that the
  // destination immediately replaces.
  const scope = key === "school" && scopeParam === "all" ? "" : scopeParam;
  return withInstitutionScope(teacherNavHref(key), scope);
}

/** Per-tab headline-query warmers, keyed by tab. Each opens a live subscription
 *  (NOT a one-shot `client.query`, which unsubscribes the instant the result
 *  lands and so never keeps the data warm) and returns its unsubscribe. The
 *  caller holds it for a short TTL so the tab's own `useQuery` shares the warm
 *  subscription on mount and paints from cache — then releases it (the dashboard
 *  deliberately keeps heavy subs like listScholars out of the persistent layout,
 *  so this is intent-scoped, never permanent). Tabs absent here still get their
 *  route prefetched. */
const TAB_WARMERS: Partial<
  Record<TeacherNavKey, (c: ConvexReactClient) => () => void>
> = {
  schedule: (c) => c.watchQuery(api.assignments.listForTeacher, {}).onUpdate(() => {}),
  scholars: (c) => c.watchQuery(api.users.listScholars, {}).onUpdate(() => {}),
};

/** How long to hold a warmed subscription after intent — long enough to cover
 *  the hover→click→mount gap, short enough to not be a lingering live sub. */
const WARM_TTL_MS = 10000;

/**
 * Warm a teacher tab on hover / focus / touch intent: prefetch its route (JS +
 * RSC) and hold its headline-data subscription briefly, so a click paints from
 * cache instead of a skeleton.
 */
export function useTeacherTabPrefetch(): (key: TeacherNavKey) => void {
  const router = useRouter();
  const convex = useConvex();
  const { user } = useCurrentUser();
  const timers = useRef(new Map<TeacherNavKey, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const active = timers.current;
    return () => {
      active.forEach(clearTimeout);
      active.clear();
    };
  }, []);
  return useCallback(
    (key: TeacherNavKey) => {
      router.prefetch(teacherNavHref(key));
      if (timers.current.has(key)) return; // already warming
      const warm =
        key === "schedule" &&
        user?.hasProgramPublishingAccess &&
        user?.hasCurriculumAccess &&
        !isTeacherRole(user.role)
          ? (client: ConvexReactClient) =>
              client
                .watchQuery(api.assignments.programScheduleOverview, {})
                .onUpdate(() => {})
          : TAB_WARMERS[key];
      if (!warm) return;
      const unsubscribe = warm(convex);
      const timer = setTimeout(() => {
        unsubscribe();
        timers.current.delete(key);
      }, WARM_TTL_MS);
      timers.current.set(key, timer);
    },
    [router, convex, user],
  );
}

export function TeacherNavTabs({
  activeKey,
  onNavigate,
  onPrefetch,
  keys,
  hrefForKey,
  homeHref,
  onHomeNavigate,
}: {
  activeKey?: TeacherNavKey;
  /** Soft-navigate to `key` on a plain left-click. The caller owns the
   *  mechanism — both the dashboard layout and the detail subroutes
   *  `router.push` to `/teacher/<tab>`. */
  onNavigate: (key: TeacherNavKey) => void;
  /** Warm `key` on hover / focus / touch intent (route + its headline data),
   *  so a click paints from cache instead of a skeleton. No-op if omitted. */
  onPrefetch?: (key: TeacherNavKey) => void;
  /** Restrict which sections render (e.g. a curriculum_designer sees fewer).
   *  Defaults to all of TEACHER_NAV, in canonical order. */
  keys?: readonly TeacherNavKey[];
  /** Optional URL builder used to preserve shareable context query params. */
  hrefForKey?: (key: TeacherNavKey) => string;
  /** Role-aware home destination rendered inside the narrow navigation drawer. */
  homeHref: string;
  /** Optional soft-navigation handler for a plain click on the drawer logo. */
  onHomeNavigate?: () => void;
}) {
  const items = keys
    ? TEACHER_NAV.filter((t) => keys.includes(t.key))
    : TEACHER_NAV;
  return (
    <TopNavTabs
      items={items.map(({ key, label, icon: Icon }) => ({
        key,
        label,
        icon: <Icon size={16} />,
      }))}
      activeKey={activeKey}
      ariaLabel="Teacher sections"
      hrefForKey={(key) =>
        hrefForKey ? hrefForKey(key) : teacherNavHref(key)
      }
      onNavigate={onNavigate}
      onPrefetch={onPrefetch}
      homeHref={homeHref}
      onHomeNavigate={onHomeNavigate}
    />
  );
}
