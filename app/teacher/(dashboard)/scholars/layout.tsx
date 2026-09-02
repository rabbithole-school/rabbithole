"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { Box, Flex, Drawer, Portal, Spinner, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import {
  useScholarRoster,
  useScholarRosterQuery,
} from "@/hooks/useScholarRoster";
import { useDefaultGroupScope } from "@/hooks/useDefaultGroupScope";
import { useDeepLinkParticipation, resolvedEnrollmentStanding } from "@/hooks/useDeepLinkParticipation";
import { ScholarProfile, type ScholarTabKey, type ScholarAddAction } from "@/components";
import { LinkGoogleDocDialog, type PickedGoogleDoc, type GoogleDocKind } from "@/components/LinkGoogleDocDialog";
import { ConceptDetail } from "@/components/MasteryTab";
import { useSetAideScope } from "@/components/aide/AideDockProvider";
import { ScholarListColumn } from "../_components/ScholarListColumn";
import { ScholarsTabBar, type ScholarsTab } from "../_components/ScholarsTabBar";
import { tabFromUrlState, urlStateForTab } from "../_components/scholarsTab";
import { ScholarWorkTable } from "../_components/ScholarWorkTable";
import { ScholarIdHead } from "../_components/ScholarIdHead";
import { GroupOverview } from "../_components/GroupOverview";
import { ScholarRailSkeleton, GenericBodySkeleton } from "../_components/Skeletons";
import { MeetingMode } from "@/components/wholeChild/MeetingMode";
import { CollapsibleRailLayout } from "@/components/ui/CollapsibleRailLayout";
import { pagerLabel } from "@/components/ui/Pager";
import { RoundsBoardHeader } from "@/components/rounds/RoundsBoardHeader";
import { HomeworkTableHeader } from "../_components/WorkTableHeader";
import { RoundsWeekPicker } from "@/components/rounds/RoundsWeekPicker";
import type { Scholar } from "../_components/types";
import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  type ScholarParticipationSelection,
} from "@/components/ScholarParticipationFilter";
import { includesProgramGuests } from "@/shared/scholarGroupRouting";
import { scholarMatchesParticipation } from "@/shared/scholarParticipation";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { useNow } from "@/hooks/useNow";
import { isWithinPrepWindow } from "@/convex/lib/metaBlocks";
import {
  parseRoundsCadenceParam,
  alignRoundsWeekKey,
  parseRoundsWeekParam,
  roundsWeekLabel,
} from "@/lib/roundsCadence";

// Scholars tab — a persistent scholar switcher (left rail) over either a
// per-scholar detail (Feed/Map/…) or, when no scholar is selected, the group
// overview (the group-scoped Class Galaxy lens). The "robot" aide is
// no longer a per-scholar rail here: it's the global header Robot → docked
// panel, which this layout scopes to the open scholar via `useSetAideScope`.
// The selected scholar + sub-tab live in the path
// (`/teacher/scholars/<username>/<subTab>`, the default `feed` sub-tab being
// bare); the friendlier USERNAME slug is resolved to the real user id from the
// loaded roster (older id-based links still resolve). The scope (`?group=`) and
// the deep-linkable observation drawer (`?obs=`) ride query params. The surface
// lives in this LAYOUT (not the page) so switching scholars or sub-tabs doesn't
// remount the rail / detail. The old roster grid is retired — the rail is the
// roster.

/** Parse `/teacher/scholars`, `/teacher/scholars/<scholarSlug>`, or
 *  `/teacher/scholars/<scholarSlug>/<subTab>` — `scholarSlug` is a username (or,
 *  for back-compat, a raw user id), resolved to an id by the layout. Scope
 *  (?group) and the observation drawer (?obs) are read from the query string. */
function parseScholarsPath(pathname: string): {
  scholarSlug: string | null;
  stab: string | null;
} {
  const rest = pathname.replace(/^\/teacher\/scholars\/?/, "");
  const parts = rest.split("/").filter(Boolean);
  // `usePathname()` returns the URL's raw (percent-encoded) path segments, so
  // a username containing characters the browser encodes (historically,
  // spaces in a pre-validation username) would otherwise be looked up still
  // encoded and spuriously 404. Decode defensively; a plain slug round-trips
  // unchanged.
  const decode = (s: string | undefined) => {
    if (!s) return null;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return { scholarSlug: decode(parts[0]), stab: decode(parts[1]) };
}

export default function ScholarsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { requestedScope: rawInst, activeInstitution } = useActiveInstitution(!!user);
  const { hasSchoolOperationsAccess } = useSchoolOperationsAccess(user, !!user);

  // School-operations staff only see non-sensitive scholar sub-tabs: the Feed overview,
  // Portfolio (the accumulated record — portfolio items), Documents (the
  // health-record half only), and Settings (identity + password + parents).
  //
  // TRI-STATE, deliberately: `hasSchoolOperationsAccess` is `undefined` until the
  // active-institution query resolves (it's skipped until `user` loads, then
  // in-flight), so collapsing the unknown to `false` would briefly render the
  // scholar detail in TEACHER mode for a school-operations staff member — mounting
  // ScholarFeed's teacher-gated queries, which `requireTeacher` throws on for a
  // `staff` role, tripping the route error boundary. So `undefined` means "not yet
  // known": hold the mode-dependent detail behind a skeleton rather than guessing.
  const isOperationsOnly: boolean | undefined =
    hasSchoolOperationsAccess === undefined
      ? undefined
      : hasSchoolOperationsAccess === true && user?.role === "staff";
  const operationsModeKnown = isOperationsOnly !== undefined;
  const validScholarTabs: ScholarTabKey[] = isOperationsOnly
    ? ["feed", "portfolio", "documents", "settings"]
    : ["feed", "map", "quests", "skills", "dossier", "documents", "now", "portfolio", "guidance", "settings"];

  const { scholarSlug: rawScholar, stab: rawStab } = parseScholarsPath(pathname);
  const rawGroup = searchParams.get("group") ?? "";
  const rawObs = searchParams.get("obs");
  const roundsMode = searchParams.get("rounds") === "1";
  const roundsCadence = parseRoundsCadenceParam(searchParams.get("rkind"));
  // `?view=tonight` selects the Homework tab (the legacy prep-window /
  // TeacherToday link). Any other value is ignored — Snapshot is the default.
  const rawView = searchParams.get("view");
  // Which week the board was showing when the scholar was opened. Rounds is
  // read back long after the meeting, so a scholar opened from a closed week
  // has to keep showing that week — and every control that leads back to the
  // board has to return to it, or the room silently lands on this week's.
  const viewedRoundsWeek = parseRoundsWeekParam(searchParams.get("rweek"));
  // Institution scope (?inst): "" = home staff membership (default), "all",
  // or a member institution's pretty slug. The slug is server-validated by
  // memberships.resolveActiveInstitution and users.listScholars before it ever
  // becomes an institution id.
  // Old `work` deep-links (the pre-split single tab) degrade gracefully: a
  // teacher lands on the live "now" snapshot, an operations staffer on "portfolio"
  // (their only slice of the old Work tab).
  const mappedStab = rawStab === "work" ? (isOperationsOnly ? "portfolio" : "now") : rawStab;
  const scholarSubTab: ScholarTabKey = validScholarTabs.includes(mappedStab as ScholarTabKey)
    ? (mappedStab as ScholarTabKey)
    : "feed";

  const resolvedInstScope =
    activeInstitution === undefined
      ? undefined
      : activeInstitution.scope === "all"
        ? "all"
        : activeInstitution.institutionSlug ?? "primary";
  const instScopeParam = activeInstitution?.scopeParam ?? rawInst;
  const roundsPeriod = useQuery(
    api.reportingPeriods.current,
    roundsMode && activeInstitution !== undefined
      ? { scope: resolvedInstScope }
      : "skip",
  );
  const roundsAgenda = useQuery(
    api.rounds.agenda,
    roundsMode &&
      roundsPeriod &&
      activeInstitution?.scope !== "all" &&
      isOperationsOnly === false
      ? {
          periodId: roundsPeriod._id,
          cadence: roundsCadence,
          scope: resolvedInstScope,
        }
      : "skip",
  );
  const [participation, setParticipation] =
    useState<ScholarParticipationSelection>(DEFAULT_SCHOLAR_PARTICIPATION);

  // The Rounds board's VIEWED week, lifted out of the board so the header row's
  // week picker owns it (staying mounted across cadence tabs is what keeps the
  // viewed week). The picker steps/picks/resets this directly and does NOT
  // touch the URL, mirroring the old in-board stepper — `?rweek` only changes
  // when navigating INTO a scholar pane. Two EXTERNAL inputs can move it: a
  // deep-link/pane-return supplying ?rweek, and the agenda's per-cadence
  // current week (which also names the cadence's ANCHOR WEEKDAY — the two
  // cadences anchor on different weekdays, Tue academic / Thu SEL, so a key
  // carried across a cadence switch must be re-anchored via alignRoundsWeekKey
  // or the exact-string meeting lookup misses: "last week" stays last week).
  //
  // Reconciled with React's render-phase adjustment pattern ("adjusting state
  // when props change"), NOT an effect — the selection records which ?rweek
  // and which anchor it was computed against, and a render that sees either
  // change re-derives + stores the adjusted key before committing. The
  // inequality guard makes the extra render one-shot, and a plain picker step
  // (which stamps the current rweek/anchor) is never clobbered.
  const agendaWeekKey = roundsAgenda?.weekKey || null;
  const [roundsWeekSel, setRoundsWeekSel] = useState<{
    key: string;
    rweekSeen: string | null;
    anchorSeen: string | null;
  } | null>(null);
  const pickWeekKey = useCallback(
    (key: string) =>
      setRoundsWeekSel({ key, rweekSeen: viewedRoundsWeek, anchorSeen: agendaWeekKey }),
    [viewedRoundsWeek, agendaWeekKey],
  );
  let viewedWeekKey: string | null;
  {
    const rweekChanged = !roundsWeekSel || roundsWeekSel.rweekSeen !== viewedRoundsWeek;
    const anchorChanged = !roundsWeekSel || roundsWeekSel.anchorSeen !== agendaWeekKey;
    const base =
      (rweekChanged ? viewedRoundsWeek : null) ?? roundsWeekSel?.key ?? agendaWeekKey;
    viewedWeekKey =
      base && agendaWeekKey ? alignRoundsWeekKey(base, agendaWeekKey) : base;
    if (viewedWeekKey && (rweekChanged || anchorChanged || viewedWeekKey !== roundsWeekSel?.key)) {
      setRoundsWeekSel({
        key: viewedWeekKey,
        rweekSeen: viewedRoundsWeek,
        anchorSeen: agendaWeekKey,
      });
    }
  }

  // The grade-column sort direction, lifted here so it PERSISTS across the
  // Homework / Academic Rounds / SEL Rounds tabs (the shared ScholarWorkTable
  // stays mounted; only its content cells swap). Ascending = youngest first.
  const [gradeSortDir, setGradeSortDir] = useState<"asc" | "desc">("asc");
  const toggleGradeSort = useCallback(
    () => setGradeSortDir((d) => (d === "asc" ? "desc" : "asc")),
    [],
  );

  // ONE Rounds-week subscription for the whole surface, shared by the meeting
  // header (framing) and the shared table (per-row content). Skipped on the
  // Homework tab and until a period + week key resolve — the table then shows
  // its columns immediately with per-cell content placeholders.
  const roundsWeek = useQuery(
    api.rounds.week,
    roundsMode &&
      isOperationsOnly === false &&
      activeInstitution?.scope !== "all" &&
      roundsPeriod &&
      viewedWeekKey
      ? {
          periodId: roundsPeriod._id,
          weekKey: viewedWeekKey,
          cadence: roundsCadence,
          scope: resolvedInstScope,
        }
      : "skip",
  );

  // Live scholar roster — scoped to THIS route (unmounts when you leave the
  // tab) so its high-frequency status/pulse subscription never runs in the
  // shared layout's steady state and can't starve route transitions.
  const scholars = useScholarRosterQuery({
    institutionScope: resolvedInstScope,
    includeProgramGuests: participation.extendedEducation,
    enabled: !!user,
  }) as Scholar[] | undefined;

  // Groups (a.k.a. Pods) + the "my scholars" affinity — the same scholarGroups
  // the roster has always used. Convex dedupes listScholars across this and the
  // query above, so this is cheap.
  const { groups, myScholarIds, isLoading: rosterMetaLoading } = useScholarRoster({
    includeProgramGuests: participation.extendedEducation,
  });

  // Resolve the URL's `<slug>` (a username, or a raw id as a fallback) → the
  // scholar's id with a dedicated indexed query (`scholars.resolveSlug`). It
  // runs in PARALLEL with the roster above, so a cold deep-link to
  // `/teacher/scholars/<username>` loads the right-hand detail without waiting
  // on the heavier roster — the detail mounts the moment this resolves.
  const slugResolution = useQuery(
    api.scholars.resolveSlug,
    rawScholar ? { slug: rawScholar } : "skip",
  );
  // FAST PATH: resolve the slug from the roster already in memory. Every
  // in-app navigation (the rail, the Rounds pager) targets a roster scholar,
  // so waiting a server round-trip per step tore the whole detail pane down to
  // the resolvingSlug spinner and rebuilt it — Andy read it as a full page
  // reload. A synchronous roster hit keeps the pane mounted; the indexed
  // server query stays as the cold-deep-link fallback (roster not yet loaded,
  // or a non-roster scholar), and remains authoritative for unknown slugs.
  const rosterSlugMatch = useMemo(() => {
    if (!rawScholar) return null;
    for (const s of scholars ?? []) {
      if (s.username === rawScholar || s.id === rawScholar) return s.id;
    }
    return null;
  }, [rawScholar, scholars]);
  const selectedScholarId = (rawScholar
    ? (rosterSlugMatch ?? slugResolution?.id ?? null)
    : null) as Id<"users"> | null;
  const resolvingSlug =
    !!rawScholar && !rosterSlugMatch && slugResolution === undefined; // no sync hit, query in flight
  const unknownSlug =
    !!rawScholar && !rosterSlugMatch && slugResolution === null; // resolved, no such scholar

  // id → username, off the loaded roster, so the URL builders emit the friendly
  // username slug. ALSO seed the currently-selected scholar from slugResolution
  // so URL builds during the parallel-load window (before the roster lands)
  // still emit the username — not the raw id — for the open scholar.
  const usernameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scholars ?? []) if (s.username) m.set(s.id, s.username);
    if (slugResolution?.id && slugResolution.username) {
      m.set(slugResolution.id, slugResolution.username);
    }
    return m;
  }, [scholars, slugResolution]);

  // Resolve the current scope: "" = all · "mine" = my scholars · else a group id.
  const activeGroup = groups.find((g) => g.id === rawGroup) ?? null;
  const scopeKey = useMemo(
    () => (rawGroup === "mine" ? "mine" : activeGroup ? activeGroup.id : ""),
    [activeGroup, rawGroup],
  );
  const scopeLabel = scopeKey === "mine" ? "My scholars" : activeGroup ? activeGroup.name : "All scholars";
  const scopeEmoji = activeGroup?.emoji ?? null;

  // Reserved subtitle line slots for the shared work-table header. A group
  // scope adds the Rounds scope-count line, so both the Rounds and Homework
  // headers reserve 2 lines while scoped and 1 otherwise — the value depends on
  // the scope, not the tab, so it holds constant across a tab switch (zero
  // layout shift). Rounds no longer has an open/closed status line, so this
  // dropped by one for all tabs together. See WorkTableHeader.
  const workHeaderReservedLines = scopeKey !== "" ? 2 : 1;

  const buildUrl = useCallback(
    (next: {
      scholar?: string | null;
      stab?: ScholarTabKey;
      group?: string;
      obs?: string | null;
      inst?: string;
      rounds?: boolean;
      rkind?: "academic" | "sel";
      rweek?: string | null;
      view?: "tonight" | null;
    }) => {
      // Scholar + sub-tab live in the path (`feed` is the bare default); the
      // scholar segment is the friendly username (falling back to the id).
      // Scope (?group), institution (?inst), and the observation drawer (?obs)
      // ride the query string. Institution persists across navigation unless
      // explicitly overridden.
      const slug = next.scholar ? (usernameById.get(next.scholar) ?? next.scholar) : null;
      const base = slug
        ? `/teacher/scholars/${slug}${next.stab && next.stab !== "feed" ? `/${next.stab}` : ""}`
        : "/teacher/scholars";
      const params = new URLSearchParams();
      if (next.group) params.set("group", next.group);
      if (next.rounds ?? roundsMode) params.set("rounds", "1");
      const rkind = next.rkind ?? roundsCadence;
      if ((next.rounds ?? roundsMode) && rkind !== "academic") {
        params.set("rkind", rkind);
      }
      // The week the room is actually looking at. Absent means the open week,
      // which is the only thing a direct link can mean. Carried explicitly
      // because a pane that quietly showed the current week while the board
      // behind it was stepped back would describe the wrong week to a room
      // that had already agreed which week it was discussing.
      if (next.rweek) params.set("rweek", next.rweek);
      // The Homework tab rides `view=tonight` (keeps the legacy link resolving).
      if (next.view) params.set("view", next.view);
      const inst = next.inst !== undefined ? next.inst : instScopeParam;
      if (inst) params.set("inst", inst);
      if (next.obs) params.set("obs", next.obs);
      const qs = params.toString();
      return `${base}${qs ? `?${qs}` : ""}`;
    },
    [usernameById, instScopeParam, roundsMode, roundsCadence],
  );

  const setSelectedScholarId = useCallback(
    (id: string | null) => {
      router.push(buildUrl({ scholar: id, stab: scholarSubTab, group: scopeKey }), {
        scroll: false,
      });
    },
    [router, buildUrl, scholarSubTab, scopeKey],
  );

  const setScholarSubTab = useCallback(
    (stab: ScholarTabKey) => {
      router.replace(buildUrl({ scholar: selectedScholarId, stab, group: scopeKey }), {
        scroll: false,
      });
    },
    [router, buildUrl, selectedScholarId, scopeKey],
  );

  // Land a teacher who RUNS a cohort (scholarGroups.ownerId) on it rather than
  // on the whole school. Only when this visit named neither a scope nor a
  // scholar — an explicit `?group=` is a deliberate choice (`has`, so a bare
  // `?group=` pins "all scholars"), and scoping a deep link to one scholar
  // would leave the rail unable to list the scholar the detail is already
  // showing. Both captured at first render, so the default can't re-fire off
  // the URL it just wrote.
  const [landedUnscoped] = useState(
    () => !searchParams.has("group") && !rawScholar,
  );
  useDefaultGroupScope({
    enabled: landedUnscoped,
    apply: (groupId) => {
      // The layout persists across child navigations, so a scholar opened
      // DURING the roster-load window (back/forward, a link into the tab)
      // would otherwise be clobbered by this replace — check again at fire
      // time, not just at mount.
      if (rawScholar) return;
      const group = groups.find((candidate) => candidate.id === groupId);
      if (group && includesProgramGuests(group)) {
        setParticipation({ enrolled: true, extendedEducation: true });
      }
      router.replace(buildUrl({ scholar: null, stab: scholarSubTab, group: groupId }), {
        scroll: false,
      });
    },
  });

  // Widen the participation filter to include Extended Education when the URL
  // this visit ARRIVED on already points at a program guest — a deep/shared link
  // into an Extended-Education scholar, or into a guest-inclusive group. Without
  // this, participation stays enrolled-only (the default), the roster omits every
  // program guest, and the rail renders empty even though the link named real
  // people the visitor can access. `useDefaultGroupScope` above only covers the
  // auto-default path (it's disabled the moment the URL carries a group/scholar),
  // so this handles the explicit-deep-link path it deliberately skips. It's a
  // URL-derived DEFAULT, not a lock: latched to fire at most once, so a user's
  // own later toggling of the Participation filter still wins for the session.
  useDeepLinkParticipation({
    scholarSlugPresent: !!rawScholar,
    // Distinguish a RESOLVED MISS (null) from STILL LOADING (undefined) — a bad
    // scholar slug must not read as "not settled yet" and block the widen.
    scholarEnrollmentStanding: resolvedEnrollmentStanding(slugResolution),
    groupId: rawGroup || null,
    groups,
    rosterLoading: rosterMetaLoading,
    apply: () =>
      setParticipation((prev) =>
        prev.extendedEducation ? prev : { ...prev, extendedEducation: true },
      ),
  });

  // Single "+ Add" menu (in the header): dispatch an intent to ScholarProfile,
  // switching to the right tab first for note/report/file. Badge overlays the
  // current tab. Google Docs are picked from the menu (the picker needs the
  // click gesture), then a small dialog collects Type + Title before linking.
  const [addAction, setAddAction] = useState<ScholarAddAction | null>(null);
  const [pendingGoogleDoc, setPendingGoogleDoc] = useState<PickedGoogleDoc | null>(null);
  const addGoogleDocLink = useMutation(api.scholarDocuments.addGoogleDocLink);
  const consumeAdd = useCallback(() => setAddAction(null), [setAddAction]);
  const handleAdd = useCallback(
    (action: ScholarAddAction) => {
      if (action === "report" || action === "file") setScholarSubTab("documents");
      else if (action === "note") setScholarSubTab("dossier");
      setAddAction(action);
    },
    [setScholarSubTab],
  );
  const handlePickedGoogleDoc = useCallback((picked: PickedGoogleDoc) => {
    setPendingGoogleDoc(picked);
  }, [setPendingGoogleDoc]);
  const handleConfirmGoogleDoc = useCallback(
    async ({ title, kind }: { title: string; kind: GoogleDocKind }) => {
      if (!selectedScholarId || !pendingGoogleDoc) return;
      await addGoogleDocLink({
        scholarId: selectedScholarId as Id<"users">,
        kind,
        title,
        link: {
          driveFileId: pendingGoogleDoc.id,
          url: pendingGoogleDoc.url || `https://docs.google.com/document/d/${pendingGoogleDoc.id}/edit`,
          name: pendingGoogleDoc.name,
          mimeType: pendingGoogleDoc.mimeType,
        },
      });
      setScholarSubTab("documents");
    },
    [addGoogleDocLink, selectedScholarId, pendingGoogleDoc, setScholarSubTab],
  );

  // Open / close one observation's evidence record as a deep-linkable drawer.
  const openObservation = useCallback(
    (obs: string) => {
      router.push(
        buildUrl({ scholar: selectedScholarId, stab: scholarSubTab, group: scopeKey, obs }),
        { scroll: false },
      );
    },
    [router, buildUrl, selectedScholarId, scholarSubTab, scopeKey],
  );
  const closeObservation = useCallback(() => {
    router.replace(buildUrl({ scholar: selectedScholarId, stab: scholarSubTab, group: scopeKey }), {
      scroll: false,
    });
  }, [router, buildUrl, selectedScholarId, scholarSubTab, scopeKey]);

  // Switching scope drops the selected scholar → land on that scope's overview.
  const setScope = useCallback(
    (key: string) => {
      router.push(buildUrl({ group: key }), { scroll: false });
    },
    [router, buildUrl],
  );

  const roster = (scholars ?? []).filter((scholar) =>
    scholarMatchesParticipation(scholar, participation),
  );
  const rosterIds = new Set(roster.map((scholar) => scholar.id));
  const visibleGroups = groups.map((group) => ({
    ...group,
    scholarIds: group.scholarIds.filter((scholarId) => rosterIds.has(scholarId)),
  }));
  const hasMine = roster.some((scholar) => myScholarIds.has(scholar.id));

  // The rail + overview both work off the scope-filtered roster.
  const memberSet = activeGroup ? new Set(activeGroup.scholarIds) : null;
  const scopedScholars =
    scopeKey === "mine"
      ? roster.filter((s) => myScholarIds.has(s.id))
      : memberSet
        ? roster.filter((s) => memberSet.has(s.id))
        : roster;
  const roundsScholars = useMemo(() => {
    if (roundsAgenda === undefined) return [];
    const base = !roundsAgenda.entries.length
      ? scopedScholars.filter(
          (scholar) => scholar.enrollmentStanding !== "program_guest",
        )
      : (() => {
          const byId = new Map(scopedScholars.map((s) => [s.id, s]));
          return roundsAgenda.entries
            .map((entry) => byId.get(String(entry.scholarId)))
            .filter((scholar): scholar is Scholar => !!scholar);
        })();
    // The pager walks the roster in the SAME order the board lists it —
    // youngest first, scholars with no birth date at the tail. Prev/next
    // following a different order than the wall everyone just read is how a
    // room loses its place.
    return [...base].sort((a, b) => {
      const aDob = a.dateOfBirth ? Date.parse(a.dateOfBirth) : NaN;
      const bDob = b.dateOfBirth ? Date.parse(b.dateOfBirth) : NaN;
      const aMissing = !Number.isFinite(aDob);
      const bMissing = !Number.isFinite(bDob);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing) return (a.name ?? "").localeCompare(b.name ?? "");
      return bDob - aDob;
    });
  }, [roundsAgenda, scopedScholars]);
  // A bare Rounds URL used to force-select the first scholar. It no longer
  // does: the week board IS the landing surface, and jumping the room straight
  // into one child skips the read-the-week step the meeting starts with.

  // No full-surface skeleton gate: the rail (roster) and the detail (one
  // scholar) load INDEPENDENTLY. A deep-link to `/teacher/scholars/<username>`
  // resolves its id (resolveSlug) and mounts the detail in parallel with the
  // roster — the rail just shows its own skeleton until listScholars returns.
  const rosterLoading = scholars === undefined;

  // Scope the global header aide to the open scholar (operations staff get the
  // general aide, matching their reduced scholar access). Falls back to
  // global on the group overview / when nothing is selected — and while the
  // operations-mode signal is still unknown, so the unknown window doesn't
  // briefly scope the aide per-scholar for a school-operations staff member.
  useSetAideScope(
    isOperationsOnly === false && selectedScholarId
      ? { kind: "scholar", scholarId: selectedScholarId as Id<"users"> }
      : { kind: "global" },
  );

  const currentScholar =
    roster.find((s) => s.id === selectedScholarId) ??
    (slugResolution
      ? {
          name: slugResolution.name ?? undefined,
          image: slugResolution.image ?? undefined,
          username: slugResolution.username,
          enrollmentStanding: slugResolution.enrollmentStanding,
        }
      : undefined);
  const roundsIndex = roundsScholars.findIndex((scholar) => scholar.id === selectedScholarId);  const previousRoundsScholar = roundsIndex > 0 ? roundsScholars[roundsIndex - 1] : null;
  const nextRoundsScholar =
    roundsIndex >= 0 && roundsIndex < roundsScholars.length - 1
      ? roundsScholars[roundsIndex + 1]
      : null;
  const roundsHref = (scholarId: string, weekKey?: string) =>
    buildUrl({
      scholar: scholarId,
      stab: "feed",
      group: scopeKey,
      rounds: true,
      rkind: roundsCadence,
      rweek: weekKey ?? null,
    });
  // The shared ScholarWorkTable's per-row navigation target. On the Rounds tabs
  // it is the pane (carrying the viewed week); on Homework it selects the
  // scholar (the same navigation the old row button did, now expressed as an
  // href so the row is a stable anchor across all three tabs).
  const workTableHref = (scholarId: string) =>
    roundsMode
      ? roundsHref(scholarId, viewedWeekKey ?? undefined)
      : buildUrl({ scholar: scholarId, stab: "feed", group: scopeKey });
  // The Scholars-tab page tab bar owns cadence now (the board's own Academic/
  // SEL toggle was removed on this surface). The active tab is derived from the
  // URL state the layout already encodes, and switching tabs writes exactly the
  // params the legacy links used — so `?rounds=1` still lands on Academic
  // Rounds and no existing link breaks. Switching cadence drops the pinned week
  // (each cadence has its own current week + continuity chain).
  const activeTab: ScholarsTab = tabFromUrlState(roundsMode, roundsCadence, rawView);
  const changeTab = useCallback(
    (tab: ScholarsTab) => {
      const s = urlStateForTab(tab);
      router.push(
        buildUrl({
          scholar: null,
          group: scopeKey,
          rounds: s.rounds,
          ...(s.rkind ? { rkind: s.rkind } : {}),
          rweek: s.rweek,
          view: s.view,
        }),
      );
    },
    [router, buildUrl, scopeKey],
  );

  // Prep-window auto-default: during a real group's Scholar's Prep window, open
  // the Homework tab automatically (retargeted from the retired Tonight
  // segment). Latched so it fires at most once per mount, and only when the URL
  // named NO tab (bare Snapshot) — a manual tab click or an explicit deep link
  // always wins. `groupPrepTimeBlock` returns the institution's canonical
  // bell-schedule window (null when the pod doesn't run the ritual).
  const prepBlock = useQuery(
    api.metaChat.groupPrepTimeBlock,
    activeGroup ? { groupId: activeGroup.id as Id<"scholarGroups"> } : "skip",
  );
  const prepNowMs = useNow(60_000);
  const prepAutoAppliedRef = useRef(false);
  const urlNamedTab = roundsMode || rawView != null;
  useEffect(() => {
    if (prepAutoAppliedRef.current) return;
    if (selectedScholarId || urlNamedTab) return;
    if (!activeGroup || !prepBlock) return;
    if (!isWithinPrepWindow(prepBlock, prepNowMs)) return;
    prepAutoAppliedRef.current = true;
    router.replace(
      buildUrl({ scholar: null, group: scopeKey, view: "tonight" }),
      { scroll: false },
    );
  }, [
    selectedScholarId,
    urlNamedTab,
    activeGroup,
    prepBlock,
    prepNowMs,
    router,
    buildUrl,
    scopeKey,
  ]);
  // An operations staffer's only Add action is a health-record upload. Reuse the merged
  // document query so that action disappears when the target scholar's school
  // cannot have the underlying forms.
  const selectedScholarDocuments = useQuery(
    api.scholarDocuments.listDocumentsForStaff,
    selectedScholarId && isOperationsOnly === true
      ? {
          scholarId: selectedScholarId as Id<"users">,
          institutionScope: resolvedInstScope,
        }
      : "skip",
  );

  return (
    <Flex flex={1} h="full" overflow="hidden" position="relative">
      {/* The roster rail renders identically on all four Scholars tabs,
          including Academic / SEL Rounds: it holds the only roster switcher and
          search, and — now that a selected scholar-group scope FILTERS the
          Rounds board — the rail's scope rows are how the room narrows the
          board to a pod. It is deliberately NOT auto-collapsed in Rounds mode
          (that stranded the scope control the meeting now depends on). Manual
          collapse via the chevron stays available on every tab; that state is
          per-mount and deliberately not persisted. */}
      <CollapsibleRailLayout
        railId="scholars-rail"
        expandAriaLabel="Show the scholar roster"
        expandedPct={15}
        minPct={10}
        maxPct={30}
        rail={() =>
          rosterLoading ? (
            <ScholarRailSkeleton />
          ) : (
            <ScholarListColumn
              scholars={scopedScholars}
              currentId={selectedScholarId ?? ""}
              onSelect={setSelectedScholarId}
              groups={visibleGroups}
              scopeKey={scopeKey}
              scopeLabel={scopeLabel}
              scopeEmoji={scopeEmoji}
              hasMine={hasMine}
              allScholarsCount={roster.length}
              onSelectScope={setScope}
              onBack={() => setScope(scopeKey)}
              participation={participation}
              onParticipationChange={setParticipation}
            />
          )
        }
      >
      <Flex direction="column" h="full" w="full" minW={0} overflow="hidden">
        {/* Page tab bar — Snapshot · Homework · Academic Rounds · SEL Rounds,
            left-aligned so the row has a right-side slot for tab-specific
            controls. Shown on the settled landing (no scholar open) for the
            teaching team; operations staff never run Rounds, so they keep their
            plain "select a scholar" landing without tabs. Cadence lives here
            now, not in the board. */}
        {!selectedScholarId &&
          !resolvingSlug &&
          !unknownSlug &&
          !rosterLoading &&
          isOperationsOnly === false && (
            <Flex
              justify="space-between"
              align="center"
              gap={4}
              px={{ base: 4, lg: 8 }}
              py={4}
              flexShrink={0}
            >
              {/* Left edge aligns with the content below (the board's
                  px={{ base: 4, lg: 8 }}); never a full-bleed band. */}
              <ScholarsTabBar active={activeTab} onChange={changeTab} />
              {/* Right slot: the Rounds week picker on the two Rounds tabs; the
                  slot is empty (row height held by the tab bar) on Snapshot /
                  Homework. Gated on a real week key, so it stays hidden while
                  the agenda loads and for an unconfigured SEL cadence. */}
              {roundsMode && roundsAgenda?.weekKey && viewedWeekKey ? (
                <RoundsWeekPicker
                  weekKey={viewedWeekKey}
                  currentWeekKey={roundsAgenda.weekKey}
                  onWeekKeyChange={pickWeekKey}
                />
              ) : null}
            </Flex>
          )}
        <Box flex={1} minH={0} w="full" overflow="hidden">
      {selectedScholarId ? (
        // ── Per-scholar detail: identity header + profile. The aide is the
        //    global header Robot → docked panel (scoped to this scholar).
        //
        //    Gate on the operations-mode signal: rendering ScholarProfile in
        //    TEACHER mode before we know the viewer is school-operations staff
        //    mounts ScholarFeed's teacher-gated queries, which throw for a
        //    `staff` role and trip the error boundary. Hold behind the neutral
        //    body skeleton until the mode is known — the rail keeps loading
        //    independently above, so only this mode-dependent detail waits.
        roundsMode && activeInstitution?.scope === "all" ? (
          <Flex flex={1} minW={0} h="full" align="center" justify="center" px={6}>
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm" textAlign="center">
              Choose one school from the account menu to run Rounds.
            </Text>
          </Flex>
        ) : roundsMode && roundsPeriod === undefined ? (
          <Box flex={1} minW={0} h="full">
            <GenericBodySkeleton />
          </Box>
        ) : roundsMode && !roundsPeriod ? (
          <Flex flex={1} minW={0} h="full" align="center" justify="center" px={6}>
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm" textAlign="center">
              No open reporting period yet. Set one up in Reports before running Rounds.
            </Text>
          </Flex>
        ) : roundsMode && isOperationsOnly === false && roundsPeriod ? (
          <Box flex={1} minW={0} h="full" overflow="hidden">
            {/* Key on the CADENCE only, never the scholar. Including
                selectedScholarId here full-remounted MeetingMode (and the
                RoundsPane below) on every left-rail switch — the pane collapsed
                to a spinner and back, flickering and jumping the layout (Andy,
                2026-08-25). MeetingMode takes scholarId as a prop and re-renders
                in place; its scholar-independent reads (agenda/week) stay warm
                and the scholar-specific ones are smoothed inside the pane. */}
            <MeetingMode
              key={roundsCadence}
              scholarId={selectedScholarId}
              scholarName={currentScholar?.name ?? "Scholar"}
              periodId={roundsPeriod._id}
              periodLabel={roundsPeriod.label}
              cadence={roundsCadence}
              backHref={buildUrl({
                scholar: null,
                group: scopeKey,
                rounds: true,
                rkind: roundsCadence,
                rweek: viewedRoundsWeek,
              })}
              breadcrumb={[
                {
                  label: "Scholars",
                  href: buildUrl({ scholar: null, group: scopeKey, rounds: false }),
                },
                {
                  // Back to the week board, still in the meeting. Leaving
                  // Rounds is deliberate and has exactly one control:
                  // "Open full profile".
                  label: viewedRoundsWeek
                    ? `Rounds · ${roundsWeekLabel(viewedRoundsWeek)}`
                    : roundsAgenda
                      ? `Rounds · ${roundsAgenda.weekLabel}`
                      : "Rounds",
                  href: buildUrl({
                    scholar: null,
                    group: scopeKey,
                    rounds: true,
                    rkind: roundsCadence,
                    rweek: viewedRoundsWeek,
                  }),
                },
                { label: currentScholar?.name ?? "Scholar" },
              ]}
              prevHref={
                previousRoundsScholar
                  ? roundsHref(previousRoundsScholar.id, viewedRoundsWeek ?? undefined)
                  : null
              }
              nextHref={
                nextRoundsScholar
                  ? roundsHref(nextRoundsScholar.id, viewedRoundsWeek ?? undefined)
                  : null
              }
              // "X of Y" through the SAME scope+participation-filtered roster
              // the pager and the board rows walk (roundsScholars), so the
              // position matches the rail. Andy asked for it back (2026-08-25):
              // in a live meeting the room wants to know how far through the
              // roster it is. Null when the scholar isn't in the paged set.
              positionLabel={pagerLabel(roundsIndex, roundsScholars.length)}
              mode="rounds"
              // "View scholar page" leaves the Rounds lens for this same
              // scholar's everyday profile (rounds off) — replaces the old
              // Rounds/Everyday segmented "toggle" that was really navigation.
              everydayHref={buildUrl({
                scholar: selectedScholarId,
                group: scopeKey,
                rounds: false,
              })}
              institutionScope={resolvedInstScope}
            />
          </Box>
        ) : !operationsModeKnown ? (
          <Box flex={1} minW={0} h="full">
            <GenericBodySkeleton />
          </Box>
        ) : (
        <>
        <Flex direction="column" flex={1} h="full" w="full" overflow="hidden">
          <ScholarIdHead
            scholar={currentScholar}
            scholarId={selectedScholarId}
            isOperationsOnly={isOperationsOnly === true}
            canFileHealthDocuments={selectedScholarDocuments?.healthDocumentsVisible}
            onAdd={handleAdd}
            onPickedGoogleDoc={handlePickedGoogleDoc}
          />
          <Box flex={1} minH={0} w="full">
            <ScholarProfile
              scholarId={selectedScholarId}
              institutionScope={resolvedInstScope}
              activeTab={scholarSubTab}
              onTabChange={setScholarSubTab}
              onOpenObservation={openObservation}
              mode={isOperationsOnly === true ? "operations" : "teacher"}
              onDelete={() => setSelectedScholarId(null)}
              addAction={addAction}
              onAddConsumed={consumeAdd}
            />
          </Box>
        </Flex>
        <LinkGoogleDocDialog
          picked={pendingGoogleDoc}
          onClose={() => setPendingGoogleDoc(null)}
          onConfirm={handleConfirmGoogleDoc}
        />
        </>
        )
      ) : resolvingSlug ? (
        // Resolving `<username>` → id (a fast indexed read); the rail loads
        // alongside this, so the only thing waiting is the detail's own data.
        <Flex flex={1} minW={0} h="full" align="center" justify="center">
          <Spinner size="lg" color="violet.500" />
        </Flex>
      ) : unknownSlug ? (
        // The URL named a scholar that doesn't exist.
        <Flex flex={1} minW={0} h="full" align="center" justify="center" color="charcoal.400" fontFamily="heading">
          No scholar found for “{rawScholar}”.
        </Flex>
      ) : rosterLoading ? (
        // Bare /teacher/scholars while the roster (which the overview needs) loads.
        <Flex flex={1} minW={0} h="full" align="center" justify="center">
          <Spinner size="lg" color="violet.500" />
        </Flex>
      ) : roundsMode && activeInstitution?.scope === "all" ? (
        <Flex flex={1} minW={0} h="full" align="center" justify="center" px={6}>
          <Text color="charcoal.400" fontFamily="heading" fontSize="md" textAlign="center">
            Choose one school from the account menu to run Rounds.
          </Text>
        </Flex>
      ) : roundsMode && isOperationsOnly ? (
        // Rounds is the teaching team's ritual, and its reads are teacher-gated
        // (reading level in particular is a measurement operations staff must
        // not see). Their agenda query is skipped, so the loading branch below
        // would hold them on a skeleton forever. Refuse in a sentence instead.
        <Flex flex={1} minW={0} h="full" align="center" justify="center" px={6}>
          <Text color="charcoal.400" fontFamily="heading" fontSize="md" textAlign="center">
            Rounds is the teaching team&rsquo;s meeting. Select a scholar from
            the list to manage their account.
          </Text>
        </Flex>
      ) : roundsMode && roundsPeriod === null ? (
        // No OPEN reporting period (resolved to null, not still loading).
        <Flex flex={1} minW={0} h="full" align="center" justify="center" px={6}>
          <Text color="charcoal.400" fontFamily="heading" fontSize="md" textAlign="center">
            No open reporting period yet. Set one up in Reports before running Rounds.
          </Text>
        </Flex>
      ) : isOperationsOnly ? (
        // Registrars administer accounts one scholar at a time — the group
        // surfaces (the Class Galaxy lens, the Workshop suggestion queue)
        // aren't theirs, and their teacher-gated queries would throw here (the
        // "Something went wrong" an operations staffer used to hit the moment they opened
        // Scholars). Prompt to pick a scholar instead; the per-scholar view is
        // already operations-staff-scoped (feed / work / settings). This is
        // BEFORE the shared table so operations staff never mount its
        // teacher-gated reads.
        <Flex
          flex={1}
          minW={0}
          h="full"
          align="center"
          justify="center"
          color="charcoal.400"
          fontFamily="heading"
          px={6}
          textAlign="center"
        >
          Select a scholar from the list to manage their account.
        </Flex>
      ) : activeTab === "homework" || roundsMode ? (
        // ── The shared scholar-work table: ONE persistent table behind the
        //    Homework · Academic Rounds · SEL Rounds tabs. It is mounted at
        //    this SINGLE position for all three tabs (no cadence/tab `key`), so
        //    switching among them keeps the grade + name columns mounted and
        //    solid — only the per-tab content cell of each row swaps. The Rounds
        //    meeting framing renders above it on the Rounds tabs; on first load
        //    of a Rounds tab the week payload is undefined and the rows still
        //    render immediately (grade + name from the roster) with a per-cell
        //    placeholder in the content column.
        <Box flex={1} minW={0} h="full" overflow="auto">
          {/* ONE header shape for all three tabs (Homework · Academic Rounds ·
              SEL Rounds), so the table's top edge never moves on a tab switch.
              `reservedLines` is derived from the scope state — which does NOT
              change on a tab switch — so both headers reserve the same subtitle
              height: 2 lines normally (window + open/closed), 3 when a group
              scope adds the scope-count line. */}
          {roundsMode ? (
            <RoundsBoardHeader
              cadence={roundsCadence}
              week={roundsWeek}
              scoped={scopeKey !== ""}
              shownCount={scopedScholars.length}
              totalCount={roundsWeek?.scholars?.length ?? scopedScholars.length}
              reservedLines={workHeaderReservedLines}
            />
          ) : (
            <HomeworkTableHeader reservedLines={workHeaderReservedLines} />
          )}
          <ScholarWorkTable
            tab={
              activeTab === "homework"
                ? "homework"
                : roundsCadence === "sel"
                  ? "sel-rounds"
                  : "academic-rounds"
            }
            scholars={scopedScholars}
            sortDir={gradeSortDir}
            onToggleSort={toggleGradeSort}
            hrefForScholar={workTableHref}
            week={roundsMode ? roundsWeek : undefined}
            weekKey={roundsMode ? viewedWeekKey : null}
            emptyState={
              <Text fontFamily="body" color="charcoal.400" fontSize="sm" py={2}>
                No scholars here yet.
              </Text>
            }
          />
        </Box>
      ) : (
        // ── Snapshot (no scholar selected): the group overview (grid + digest).
        <Box flex={1} minW={0} h="full">
          <GroupOverview
            groupId={activeGroup?.id}
            scholars={scopedScholars}
            totalScholars={roster.length}
            onSelectScholar={setSelectedScholarId}
            institutionScope={resolvedInstScope}
          />
        </Box>
      )}
        </Box>
      </Flex>
      </CollapsibleRailLayout>

      {/* Deep-linkable evidence-record drawer (?obs=<observationId>) — opened
          from a Feed mastery row, a Mastery-list row, or a pasted link, so a
          teacher can reference "this observation is wrong". */}
      <Drawer.Root
        open={!!rawObs && !!selectedScholarId}
        onOpenChange={(d) => !d.open && closeObservation()}
        placement="end"
        size="md"
      >
        <Portal>
          <Drawer.Backdrop bg="blackAlpha.300" zIndex={1600} />
          <Drawer.Positioner zIndex={1600}>
            <Drawer.Content data-testid="observation-drawer">
              <Drawer.Header borderBottom="1px solid" borderColor="gray.100" px={5} py={3}>
                <Flex justify="space-between" align="center" w="full">
                  <Drawer.Title fontFamily="heading" fontWeight="700" fontSize="md" color="navy.600">
                    Mastery observation
                  </Drawer.Title>
                  <Drawer.CloseTrigger asChild>
                    <Box as="button" data-testid="observation-drawer-close" color="charcoal.400" _hover={{ color: "charcoal.600" }} aria-label="Close">
                      <X size={18} weight="bold" />
                    </Box>
                  </Drawer.CloseTrigger>
                </Flex>
              </Drawer.Header>
              <Drawer.Body px={5} py={4}>
                {rawObs && selectedScholarId ? (
                  <ConceptDetail
                    scholarId={selectedScholarId}
                    observationId={rawObs}
                    onClose={closeObservation}
                  />
                ) : null}
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      {/* Route-transition loading fallback overlays the surface instead of
          stacking below it (no double-skeleton on a client nav into the tab);
          pointerEvents:none passes clicks through. */}
      <Box position="absolute" inset={0} pointerEvents="none">
        {children}
      </Box>
    </Flex>
  );
}
