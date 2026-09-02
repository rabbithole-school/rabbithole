"use client";

/**
 * MathSkillsStudioShell — the full-bleed shell for the Math Skills studio,
 * shared by BOTH lenses (Mastery and Content). It is the studio's twin of the
 * Units tab: a header band (title + lens toggle + the SAME consolidated
 * group/scholar scope picker the Scholars tab uses) over a
 * `CollapsibleRailLayout` whose left rail is the domain rail — so the domain
 * navigation is IDENTICAL across lenses, and either lens fills the width when
 * the rail is collapsed.
 *
 * The shell owns the roster + scope (group + drilled-in scholar) once and hands
 * the resolved scope to the lens body via a render prop, so the Mastery body is
 * a pure content view. Content ignores the scope (content is cohort-agnostic),
 * so its scope controls are hidden — but it shares the rail.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { MathSkillsScopeButton } from "@/components/practice/MathSkillsScopeButton";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { CollapsibleRailLayout } from "@/components/ui/CollapsibleRailLayout";
import { COLUMN_HEADER_HEIGHT } from "@/components/hierarchy";
import {
  MathSkillsDomainRail,
  ALL_DOMAINS_DOMAIN,
  FAST_MATH_DOMAIN,
} from "@/components/practice/MathSkillsDomainRail";
import {
  useScholarRoster,
  type RosterGroup,
  type RosterScholar,
} from "@/hooks/useScholarRoster";
import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  scholarMatchesParticipation,
  type ScholarParticipationSelection,
} from "@/shared/scholarParticipation";
import { groupMatchesParticipation } from "@/shared/scholarGroupRouting";
import { ChartDonut, PencilSimple, Shapes } from "@phosphor-icons/react";

type PracticeDomain = { domain: string; label: string };
type MathSkillsLens = "mastery" | "content" | "manipulatives";

export type StudioScopeContext = {
  scholars: RosterScholar[];
  groups: RosterGroup[];
  myScholarIds: Set<string>;
  rosterLoading: boolean;
  scopedScholars: RosterScholar[];
  effectiveScholar: RosterScholar | undefined;
  effectiveScholarId: string;
  scopeLabel: string;
  /** The selected group's id (scopeKey when it is a group), else null. Lets the
   *  Mastery body scope the node-anchored checkpoint flags to a settable unit. */
  scopeGroupId: string | null;
  /** The selected group's durable server name, else null when scope is not a
   *  real group. This is resolved with the group row, not a checkpoint query. */
  scopeGroupName: string | null;
  /**
   * Deprecated seam: the scope control now lives as a single button in the
   * shell header band, not in the Mastery body's control row. This is always
   * `null` — kept only so the existing prop plumbing into the Mastery body
   * stays intact while that body drops its former in-body scope-control slot.
   */
  scopeControls: ReactNode;
};

export function MathSkillsStudioShell({
  lens,
  onLensChange,
  mayViewMastery,
  scopeKey,
  onSelectScope,
  scholar,
  onSelectScholar,
  domains,
  selectedDomain,
  onSelectDomain,
  children,
}: {
  lens: MathSkillsLens;
  onLensChange: (lens: MathSkillsLens) => void;
  mayViewMastery: boolean;
  scopeKey: string;
  /** `replace: true` marks an automatic correction — no history entry. */
  onSelectScope: (scopeKey: string, opts?: { replace?: boolean }) => void;
  scholar: string;
  onSelectScholar: (scholar: string) => void;
  domains: PracticeDomain[];
  selectedDomain: string;
  onSelectDomain: (domain: string) => void;
  children: (ctx: StudioScopeContext) => React.ReactNode;
}) {
  const [participation, setParticipation] =
    useState<ScholarParticipationSelection>(DEFAULT_SCHOLAR_PARTICIPATION);
  const {
    scholars: rosterScholars,
    groups,
    myScholarIds,
    isLoading: rosterLoading,
  } = useScholarRoster({
    includeProgramGuests: participation.extendedEducation,
  });

  const scholars = useMemo(
    () =>
      rosterScholars.filter((candidate) =>
        scholarMatchesParticipation(candidate, participation),
      ),
    [participation, rosterScholars],
  );

  const scopeGroup = groups.find((group) => group.id === scopeKey);
  const hasMine = scholars.some((candidate) => myScholarIds.has(candidate.id));

  // Scope is URL state but participation is component state, so a reload or
  // deep link can restore a scope the current filter hides (blank matrix, no
  // pill lit). Reconcile once the roster settles, with the same predicates
  // onParticipationChange applies at switch time. An automatic correction is
  // not an undoable navigation step, so it clears with { replace: true }.
  // NOTE: `rosterLoading` stays false during the enrolled→extended widening
  // window (the roster hook retains the enrolled fallback); this effect never
  // false-clears there only because onParticipationChange pre-clears anything
  // guest-dependent before setParticipation, leaving scopeKey === "".
  useEffect(() => {
    if (rosterLoading || scopeKey === "") return;
    if (scopeKey === "mine") {
      if (!hasMine) onSelectScope("", { replace: true });
      return;
    }
    if (
      !scopeGroup ||
      !groupMatchesParticipation(scopeGroup, participation.extendedEducation) ||
      !scopeGroup.scholarIds.some((id) =>
        scholars.some((candidate) => candidate.id === id),
      )
    ) {
      onSelectScope("", { replace: true });
    }
  }, [
    hasMine,
    onSelectScope,
    participation.extendedEducation,
    rosterLoading,
    scholars,
    scopeGroup,
    scopeKey,
  ]);

  const scopedScholars = useMemo(() => {
    const filtered =
      scopeKey === "mine"
        ? scholars.filter((candidate) => myScholarIds.has(candidate.id))
        : scopeGroup
          ? scholars.filter((candidate) =>
              scopeGroup.scholarIds.includes(candidate.id),
            )
          : scholars;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [myScholarIds, scholars, scopeGroup, scopeKey]);

  const effectiveScholar = scopedScholars.find(
    (candidate) => (candidate.username ?? candidate.id) === scholar,
  );
  const effectiveScholarId = effectiveScholar?.id ?? "";

  const scopeLabel =
    scopeKey === "mine"
      ? "My scholars"
      : (scopeGroup?.name ?? "All groups");

  const showRail = domains.length > 1 && lens !== "manipulatives";
  const isMastery = lens === "mastery";
  const isManipulatives = lens === "manipulatives";

  const selectedDomainLabel =
    selectedDomain === ALL_DOMAINS_DOMAIN
      ? "All domains"
      : selectedDomain === FAST_MATH_DOMAIN
        ? "Fast math"
      : (domains.find((entry) => entry.domain === selectedDomain)?.label ?? "");

  // The consolidated "who am I looking at" control — ONE button in the studio
  // header band (below), beside the domain title. It scopes to a group (the
  // matrix's column pool) OR drills into a single scholar, all from one popover.
  // Only the Mastery lens is scholar-scoped; Content and Manipulatives are
  // cohort-agnostic, so they expose no scope control. The former in-body
  // `scopeControls` slot is gone — Mastery no longer renders a second control
  // row (Lane C), so we pass `null` through the existing plumbing.
  const scopeButton: ReactNode = isMastery ? (
    <MathSkillsScopeButton
      groups={groups}
      scopeKey={scopeKey}
      hasMine={hasMine}
      onSelectScope={(key) => {
        onSelectScope(key);
        if (!effectiveScholar) return;
        const nextGroup = groups.find((group) => group.id === key);
        const remainsVisible =
          key === ""
            ? true
            : key === "mine"
              ? myScholarIds.has(effectiveScholar.id)
              : nextGroup?.scholarIds.includes(effectiveScholar.id) === true;
        if (!remainsVisible) onSelectScholar("");
      }}
      visibleScholarIds={scholars.map((candidate) => candidate.id)}
      scopedScholarIds={scopedScholars.map((s) => s.id)}
      effectiveScholar={effectiveScholar}
      onSelectScholar={onSelectScholar}
      participation={participation}
      onParticipationChange={(next) => {
        const nextVisibleScholarIds = new Set(
          rosterScholars
            .filter((candidate) =>
              scholarMatchesParticipation(candidate, next),
            )
            .map((candidate) => candidate.id),
        );
        if (
          scopeGroup &&
          (!groupMatchesParticipation(
            scopeGroup,
            next.extendedEducation,
          ) ||
            !scopeGroup.scholarIds.some((id) =>
              nextVisibleScholarIds.has(id),
            ))
        ) {
          onSelectScope("");
        }
        if (
          scopeKey === "mine" &&
          ![...myScholarIds].some((id) => nextVisibleScholarIds.has(id))
        ) {
          onSelectScope("");
        }
        if (
          effectiveScholar &&
          !scholarMatchesParticipation(effectiveScholar, next)
        ) {
          onSelectScholar("");
        }
        setParticipation(next);
      }}
    />
  ) : null;

  const ctx: StudioScopeContext = {
    scholars,
    groups,
    myScholarIds,
    rosterLoading,
    scopedScholars,
    effectiveScholar,
    effectiveScholarId,
    scopeLabel,
    scopeGroupId: scopeGroup?.id ?? null,
    scopeGroupName: scopeGroup?.name ?? null,
    // The scope control now lives in the shell header band (a single button),
    // not in the Mastery body's control row — so nothing flows down here.
    scopeControls: null,
  };

  const content = children(ctx);

  // Header band — the selected domain name (a content-column header, parallel
  // to the rail's DOMAINS header) + the single scope button (Mastery only) on
  // the left cluster beside the title, and the lens toggle on the right. It
  // lives in the CONTENT column, NOT above the whole studio: neither the lens
  // toggle nor the scholar focus affects the domain rail, so the rail spans the
  // full height to the top and this band aligns with the rail's own DOMAINS
  // header (COLUMN_HEADER_HEIGHT). The scope control is ONE button here ("what /
  // whom am I looking at"), replacing the former standing pill row; the "Math
  // Skills" title is dropped (the dashboard tab already names the surface). The
  // domain name is the ONE canonical title for the content column in BOTH
  // lenses, so Content no longer repeats it as a "<domain> coverage" heading
  // below. The durable math-group checkpoint lives HERE (next to the name)
  // rather than in a second panel or picker.
  const header = (
    <Flex
      px={{ base: 3, md: 5 }}
      align="center"
      justify="space-between"
      gap={3}
      h={COLUMN_HEADER_HEIGHT}
      minH={COLUMN_HEADER_HEIGHT}
      borderBottomWidth="1px"
      borderColor="gray.200"
      bg="white"
      flexShrink={0}
      userSelect="none"
    >
      <HStack gap={3} minW={0} flex={1} align="center">
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="sm"
          color="navy.600"
          lineClamp={1}
          minW={0}
          flexShrink={0}
        >
          {/* The Library spans every domain, so a domain name would misread as
              a filter — name the catalog instead. */}
          {isManipulatives ? "Manipulative library" : selectedDomainLabel}
        </Text>
        {scopeButton}
      </HStack>

      <HStack gap={2} align="center" flexShrink={0}>
        {/* Lens toggle. Content and Manipulatives are available to every
            curriculum role; Mastery is added only for teachers (the roster/
            scholar-scoped lens). The Library is a third lens rather than a new
            top-level tab — same room, different furniture, one click from the
            Content lens where authoring happens. */}
        <ViewToggle
          items={[
            ...(mayViewMastery
              ? [
                  {
                    value: "mastery",
                    label: "Mastery",
                    icon: <ChartDonut size={14} />,
                  },
                ]
              : []),
            {
              value: "content",
              label: "Content",
              icon: <PencilSimple size={14} />,
            },
            {
              value: "manipulatives",
              label: "Manipulatives",
              icon: <Shapes size={14} />,
            },
          ]}
          value={lens}
          onChange={(next) => onLensChange(next as MathSkillsLens)}
          ariaLabel="Math skills lens"
          testId="math-skills-lens"
        />
      </HStack>
    </Flex>
  );

  const body = (
    <Flex direction="column" h="full" minW={0}>
      {header}
      <Box flex={1} minH={0} overflow="hidden">
        {content}
      </Box>
    </Flex>
  );

  return (
    <Flex direction="column" h="full" minW={0} overflow="hidden" bg="gray.50">
      {/* Shared collapsible domain rail (full height, to the top) + the lens
          body (its own header band over the lens content). */}
      {showRail ? (
        <CollapsibleRailLayout
          railId="domains"
          expandAriaLabel="Expand domains"
          rail={({ collapse }) => (
            <MathSkillsDomainRail
              domains={domains}
              selectedDomain={selectedDomain}
              onSelectDomain={onSelectDomain}
              showAllDomainsOption
              showFastMathOption={isMastery}
              onCollapse={collapse}
            />
          )}
        >
          {body}
        </CollapsibleRailLayout>
      ) : (
        body
      )}
    </Flex>
  );
}
