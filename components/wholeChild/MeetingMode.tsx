"use client";

/**
 * Meeting mode (review/assessment-and-goals-plan.html §8) — the per-child,
 * per-category screen the team works from live: pooled category-tagged
 * observations (left, any staffer's ambient notes all period long) next to the
 * advisor's "agreed read" (right, one of the Whole Child Narrative's sections).
 * "Agree ✓" commits the drafted sentence and moves to the next category;
 * "Skip — nothing to add" moves on without touching the section (legitimate
 * per Carl's guidance — the final doc still renders a one-liner for a
 * skipped category). The advisor can also free-edit any section directly —
 * typing autosaves (debounced) regardless of the Agree/Skip flow.
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Stack, Switch, Tabs, Text, Textarea, Spinner } from "@chakra-ui/react";
import { ArrowSquareOut, Check, ShareNetwork, UsersThree } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { PaneTabs } from "@/components/ui/PaneTabs";
import { Pager } from "@/components/ui/Pager";
import type { Crumb } from "@/components/ui/Breadcrumb";
import { ReportShell } from "@/components/narrative/ReportShell";
import { SectionStatusIcon, sectionState } from "@/components/narrative/SectionStatusIcon";
import {
  reportDone,
  reportShared,
  SharedTag,
  MarkReportDoneToggle,
} from "@/components/narrative/reportStatus";
import { formatTimeAgo } from "@/lib/relativeTime";
import { RoundsPane } from "@/components/wholeChild/RoundsPane";
import { ScholarFocusHeader } from "@/app/teacher/(dashboard)/_components/ScholarFocusHeader";

export interface MeetingModeProps {
  scholarId: Id<"users">;
  scholarName: string;
  periodId: Id<"reportingPeriods">;
  periodLabel: string;
  /** Roster link — "All scholars". */
  backHref: string;
  /** Breadcrumb trail (e.g. All scholars › Scholar › Whole Child). Falls back
   *  to a simple "All scholars" link built from backHref when omitted. */
  breadcrumb?: Crumb[];
  prevHref?: string | null;
  nextHref?: string | null;
  /** e.g. "4 of 12". */
  positionLabel?: string | null;
  /** The weekly Rounds attachment; report mode remains the default. */
  mode?: "report" | "rounds";
  /** Which Rounds cadence the pane reads (rounds mode only). */
  cadence?: "academic" | "sel";
  /** Rounds mode: where the header's "View scholar page" button navigates —
   *  the same scholar's everyday profile (Rounds lens off). */
  everydayHref?: string | null;
  institutionScope?: string;
}

type CategoryKey = "execFunction" | "socialEmotional" | "collaboration" | "passions" | "goals";
/** The observation category a tab pools from — `null` for Goals, which has no
 * matching observation category (it draws on scholarGoals). */
type InputCategory = "execFunction" | "socialEmotional" | "collaboration" | "passions";

const CATEGORIES: {
  key: CategoryKey;
  /** Short label for the tab strip. */
  label: string;
  /** Full section title, saved to wholeChildNarratives.sections. */
  title: string;
  inputCategory: InputCategory | null;
  hint?: string;
}[] = [
  {
    key: "execFunction",
    label: "Executive function",
    title: "Executive Function & Learning Habits",
    inputCategory: "execFunction",
  },
  {
    key: "socialEmotional",
    label: "Social-emotional",
    title: "Social-Emotional Growth",
    inputCategory: "socialEmotional",
  },
  {
    key: "collaboration",
    label: "Collaboration & character",
    title: "Collaboration, Character & Community",
    inputCategory: "collaboration",
  },
  {
    key: "passions",
    label: "Passions & quests",
    title: "Passion Projects, Quests & Extended Learning",
    inputCategory: "passions",
    hint: "Quests, seeds pursued, share-backs, and portfolio items largely write this one — humanize the factual list.",
  },
  {
    key: "goals",
    label: "Goals",
    title: "Goals for Continued Growth",
    inputCategory: null,
    hint: "This scholar's active goals are shown here — capture the team's read on progress and the next stretch.",
  },
];

const AUTOSAVE_DELAY_MS = 900;

export function MeetingMode({
  scholarId,
  scholarName,
  periodId,
  periodLabel,
  backHref,
  breadcrumb,
  prevHref,
  nextHref,
  positionLabel,
  mode = "report",
  cadence = "academic",
  everydayHref,
  institutionScope,
}: MeetingModeProps) {
  const [activeCategory, setActiveCategory] = useState<CategoryKey | "approvals">("execFunction");

  const narrative = useQuery(
    api.wholeChildNarratives.getForScholarPeriod,
    mode === "report" ? { scholarId, periodId } : "skip",
  );
  const inputs = useQuery(
    api.wholeChild.listForScholarPeriod,
    mode === "report" ? { scholarId, periodId } : "skip",
  );
  const activeGoals = useQuery(
    api.scholarGoals.listByScholar,
    mode === "report" ? { scholarId, status: "active" } : "skip",
  );

  const openNarrative = useMutation(api.wholeChildNarratives.open);
  const saveSection = useMutation(api.wholeChildNarratives.saveSection);
  const markTeamAgreed = useMutation(api.wholeChildNarratives.markTeamAgreed);
  const share = useMutation(api.wholeChildNarratives.share);
  const setDone = useMutation(api.wholeChildNarratives.setDone);
  const setSectionDone = useMutation(api.wholeChildNarratives.setSectionDone);
  const [publishing, setPublishing] = useState(false);

  // Whole Child Narratives are opened lazily — the first meeting-mode visit
  // for this scholar × period creates the doc. `open` is idempotent
  // (returns the existing row if one's already there), but guard against a
  // double-fire from React's dev double-effect anyway.
  const openingRef = useRef(false);
  useEffect(() => {
    // Report mode owns the narrative's lifecycle. Flicking through Rounds must
    // not silently mint a draft narrative for every scholar on the agenda.
    if (mode !== "report") return;
    if (narrative === null && !openingRef.current) {
      openingRef.current = true;
      openNarrative({ scholarId, periodId }).finally(() => {
        openingRef.current = false;
      });
    }
  }, [mode, narrative, scholarId, periodId, openNarrative]);

  // Local drafts, seeded ONCE per section key from the loaded narrative so a
  // concurrent reactive update never stomps on text the advisor is mid-typing.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const savedRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!narrative) return;
    // Seed local drafts from the newly-loaded/created narrative once per
    // section key — never overwrite a key already present (in-progress edit).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of narrative.sections) {
        if (next[s.key] === undefined) {
          next[s.key] = s.body;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const s of narrative.sections) {
      if (savedRef.current[s.key] === undefined) savedRef.current[s.key] = s.body;
    }
  }, [narrative]);

  // Debounced autosave of the ACTIVE category's draft — "the advisor can
  // also edit any section freely" independent of the Agree/Skip flow.
  useEffect(() => {
    if (!narrative) return;
    const key = activeCategory;
    const value = drafts[key];
    if (value === undefined || savedRef.current[key] === value) return;
    const cat = CATEGORIES.find((c) => c.key === key);
    const timer = setTimeout(() => {
      saveSection({ narrativeId: narrative._id, key, body: value, title: cat?.title }).then(() => {
        savedRef.current[key] = value;
      });
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the active category's draft only
  }, [drafts[activeCategory], activeCategory, narrative, saveSection]);

  // Flush ALL pending edits on unmount (navigating prev/next/away, or switching
  // scholars) — mirrors NarrativeSectionEditor. Without this, an edit made in a
  // category then left before its debounce fires (e.g. tab-switch clears the
  // timer) would be lost on navigation even though the UI showed it as edited.
  const flushPendingEdits = useEffectEvent(() => {
    const narrativeId = narrative?._id;
    if (!narrativeId) return;
    for (const [key, value] of Object.entries(drafts)) {
      if (value !== savedRef.current[key]) {
        const cat = CATEGORIES.find((c) => c.key === key);
        saveSection({ narrativeId, key, body: value, title: cat?.title }).catch(() => {});
      }
    }
  });
  useEffect(() => {
    return () => flushPendingEdits();
  }, []);

  const activeIndex = CATEGORIES.findIndex((c) => c.key === activeCategory);
  const advance = () => {
    const next = CATEGORIES[activeIndex + 1];
    if (next) setActiveCategory(next.key);
  };

  const handleAgree = async () => {
    if (!narrative) return;
    const cat = CATEGORIES[activeIndex];
    const body = drafts[cat.key] ?? "";
    await saveSection({ narrativeId: narrative._id, key: cat.key, body, title: cat.title });
    savedRef.current[cat.key] = body;
    advance();
  };

  const handleSkip = () => advance();

  const handleMarkTeamAgreed = async () => {
    if (!narrative) return;
    await markTeamAgreed({ narrativeId: narrative._id });
  };

  const handleSectionDone = async (key: string, title: string, done: boolean) => {
    if (!narrative) return;
    await setSectionDone({ narrativeId: narrative._id, key, done, title });
  };

  const handleSetDone = async (done: boolean) => {
    if (!narrative) return;
    await setDone({ narrativeId: narrative._id, done });
  };

  const handleShare = async () => {
    if (!narrative) return;
    setPublishing(true);
    try {
      await share({ narrativeId: narrative._id });
    } finally {
      setPublishing(false);
    }
  };

  const loading = narrative === undefined || inputs === undefined;

  const crumbs: Crumb[] = breadcrumb ?? [
    { label: "All scholars", href: backHref },
    { label: scholarName },
    { label: mode === "rounds" ? "Rounds" : "Whole Child" },
  ];

  return (
    <ReportShell crumbs={crumbs} scholarId={scholarId}>
      <ScholarFocusHeader
        scholarId={scholarId}
        name={scholarName}
        scale="report"
        detail={
          <Text lineClamp={1}>
            {mode === "rounds" ? "Rounds" : "Whole Child"} · {periodLabel}
          </Text>
        }
        pager={
          <Pager
            prevHref={prevHref}
            nextHref={nextHref}
            label={positionLabel}
            navLabel="Scholar navigation"
            prevLabel="Previous scholar"
            nextLabel="Next scholar"
          />
        }
        actions={
          mode === "rounds" ? (
            // Rounds is a lens over one scholar; "View scholar page" is the one
            // way OUT to their everyday profile. It's a link (not a segmented
            // toggle) because it navigates rather than switching an in-place
            // state — see the PR that removed the Rounds/Everyday "toggle".
            everydayHref ? (
              <Button
                asChild
                size="xs"
                variant="outline"
                color="charcoal.500"
                borderColor="gray.200"
                fontFamily="heading"
                fontWeight="600"
                _hover={{ bg: "gray.50" }}
              >
                <Link href={everydayHref}>
                  <ArrowSquareOut />
                  View scholar page
                </Link>
              </Button>
            ) : undefined
          ) : mode === "report" && narrative ? (
            <HStack gap={2}>
              <SharedTag status={narrative.status} />
              <MarkReportDoneToggle
                done={reportDone(narrative.status)}
                onToggle={handleSetDone}
                disabled={reportShared(narrative.status)}
                label="Mark report as done"
              />
            </HStack>
          ) : undefined
        }
      />

      {/* No strapline above Rounds. One described the old disposition model
          ("make one team call") and outlived it, but the deeper reason not to
          replace it is that nothing is left for it to say: the header names the
          scholar and the lens, the pane's first card names the week and its
          window, and the sections below run in the order of the ritual — last
          week, this week, guidance, the note. A sentence restating that would
          be a fourth telling, set smaller than everything it describes. */}
      <Box px={6} pb={6} pt={3} flex={1} minH={0}>
        {mode === "rounds" ? (
          // Key on the CADENCE only. Keying on scholarId remounted the pane on
          // every scholar switch → spinner flash + layout jump; the pane now
          // re-renders in place and smooths its scholar-specific reads (below).
          <RoundsPane
            key={cadence}
            scholarId={scholarId}
            scholarName={scholarName}
            periodId={periodId}
            cadence={cadence}
            institutionScope={institutionScope}
          />
        ) : loading ? (
          <Flex align="center" justify="center" h="full">
            <Spinner size="lg" color="violet.500" />
          </Flex>
        ) : (
          <PaneTabs
            value={activeCategory}
            onChange={(v) => setActiveCategory(v as CategoryKey | "approvals")}
            mb={4}
            items={[
              ...CATEGORIES.map((cat) => {
                const hasContent = !!drafts[cat.key]?.trim();
                const isDone = !!narrative?.sections.find((s) => s.key === cat.key)?.done;
                return {
                  value: cat.key,
                  label: cat.label,
                  icon: <SectionStatusIcon state={sectionState(hasContent, isDone)} size={13} />,
                };
              }),
              {
                value: "approvals",
                label: "Approvals",
                icon: <SectionStatusIcon state={narrative?.teamAgreedAt ? "done" : "empty"} size={13} />,
              },
            ]}
          >

            {CATEGORIES.map((cat) => (
              <Tabs.Content key={cat.key} value={cat.key}>
                <CategoryPane
                  category={cat}
                  inputs={(inputs ?? []).filter((i) => i.category === cat.inputCategory)}
                  activeGoals={activeGoals ?? []}
                  draft={drafts[cat.key] ?? ""}
                  onDraftChange={(v) => setDrafts((d) => ({ ...d, [cat.key]: v }))}
                  onAgree={handleAgree}
                  onSkip={handleSkip}
                  done={!!narrative?.sections.find((s) => s.key === cat.key)?.done}
                  onToggleDone={(done) => handleSectionDone(cat.key, cat.title, done)}
                  isLast={activeIndex === CATEGORIES.length - 1 && cat.key === activeCategory}
                />
              </Tabs.Content>
            ))}

            <Tabs.Content value="approvals">
              <ApprovalsPane
                teamAgreedAt={narrative?.teamAgreedAt ?? null}
                status={narrative?.status ?? "draft"}
                disabled={!narrative}
                publishing={publishing}
                onTeamAgreed={handleMarkTeamAgreed}
                onShare={handleShare}
              />
            </Tabs.Content>
          </PaneTabs>
        )}
      </Box>
    </ReportShell>
  );
}

function CategoryPane({
  category,
  inputs,
  activeGoals,
  draft,
  onDraftChange,
  onAgree,
  onSkip,
  done,
  onToggleDone,
  isLast,
}: {
  category: (typeof CATEGORIES)[number];
  inputs: { _id: string; note: string; authorName: string; _creationTime: number }[];
  activeGoals: { _id: string; title: string; description?: string; kind: string }[];
  draft: string;
  onDraftChange: (v: string) => void;
  onAgree: () => void;
  onSkip: () => void;
  done: boolean;
  onToggleDone: (done: boolean) => void;
  isLast: boolean;
}) {
  const isGoals = category.inputCategory === null;
  return (
    <Flex gap={4} align="stretch" wrap="wrap">
      <Surface flex="1 1 380px" minW="320px" p={4}>
        <SectionEyebrow>{isGoals ? "Active goals" : "Pooled inputs"}</SectionEyebrow>
        {isGoals ? (
          <Stack gap={2} mt={3}>
            <Text fontSize="xs" color="charcoal.400" fontFamily="body" mb={1}>
              {category.hint}
            </Text>
            {activeGoals.length === 0 ? (
              <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                No active goals for this scholar yet.
              </Text>
            ) : (
              activeGoals.map((g) => (
                <Box key={g._id} borderWidth="1px" borderColor="gray.200" borderRadius="md" px={3} py={2}>
                  <HStack justify="space-between" mb={g.description ? 1 : 0}>
                    <Text fontSize="sm" fontWeight="700" fontFamily="heading" color="navy.500">
                      {g.title}
                    </Text>
                    <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" textTransform="uppercase">
                      {g.kind}
                    </Text>
                  </HStack>
                  {g.description && (
                    <Text fontSize="sm" color="charcoal.600" fontFamily="body">
                      {g.description}
                    </Text>
                  )}
                </Box>
              ))
            )}
          </Stack>
        ) : (
          <Stack gap={2} mt={3}>
            {category.hint && (
              <Text fontSize="xs" color="charcoal.400" fontFamily="body" mb={1}>
                {category.hint}
              </Text>
            )}
            {inputs.length === 0 ? (
              <Text fontSize="sm" color="charcoal.400" fontFamily="heading">
                No inputs yet for this category.
              </Text>
            ) : (
              inputs.map((input) => (
                <Box key={input._id} borderWidth="1px" borderColor="gray.200" borderRadius="md" px={3} py={2}>
                  <HStack justify="space-between" mb={1}>
                    <Text fontSize="xs" fontWeight="700" fontFamily="heading" color="navy.500">
                      {input.authorName}
                    </Text>
                    <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                      {formatTimeAgo(input._creationTime)}
                    </Text>
                  </HStack>
                  <Text fontSize="sm" color="charcoal.600" fontFamily="body">
                    {input.note}
                  </Text>
                </Box>
              ))
            )}
          </Stack>
        )}
      </Surface>

      <Surface flex="1 1 380px" minW="320px" p={4}>
        <SectionEyebrow>Team&apos;s agreed read (advisor captures)</SectionEyebrow>
        <Textarea
          mt={3}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          rows={8}
          bg="gray.50"
          fontFamily="body"
          fontSize="sm"
          placeholder="A sentence or two the team agrees on…"
        />
        <HStack gap={2} mt={3}>
          <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={onAgree} disabled={!draft.trim()}>
            <Check style={{ marginRight: 4 }} /> Agree ✓
          </Button>
          <Button size="sm" variant="ghost" fontFamily="heading" onClick={onSkip}>
            Skip — nothing to add
          </Button>
          <Switch.Root
            checked={done}
            onCheckedChange={(d) => onToggleDone(!!d.checked)}
            colorPalette="green"
            size="sm"
            ml="auto"
          >
            <Switch.HiddenInput />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Label fontSize="xs" fontFamily="heading" color="charcoal.500">
              Mark as done
            </Switch.Label>
          </Switch.Root>
        </HStack>
        {isLast && (
          <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" mt={2}>
            Last category — the Approvals tab wraps up the meeting.
          </Text>
        )}
      </Surface>
    </Flex>
  );
}

function ApprovalsPane({
  teamAgreedAt,
  status,
  disabled,
  publishing,
  onTeamAgreed,
  onShare,
}: {
  teamAgreedAt: number | null;
  status: string;
  disabled: boolean;
  publishing: boolean;
  onTeamAgreed: () => void;
  onShare: () => void;
}) {
  return (
    <Flex gap={4} align="stretch" wrap="wrap">
      <Surface flex="1 1 380px" minW="320px" p={4}>
        <Stack gap={3}>
          <SectionEyebrow>Team consensus</SectionEyebrow>
          <Text fontSize="sm" color="charcoal.500" fontFamily="body">
            One team-authored read per scholar. Stamp it once the team has agreed in the meeting.
          </Text>
          {teamAgreedAt ? (
            <HStack gap={1.5} color="teal.700" fontFamily="heading" fontSize="sm" fontWeight="600">
              <UsersThree />
              <Text>Team agreed {formatTimeAgo(teamAgreedAt)}</Text>
            </HStack>
          ) : (
            <Box>
              <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={onTeamAgreed} disabled={disabled}>
                <UsersThree style={{ marginRight: 4 }} /> Team agreed
              </Button>
            </Box>
          )}
        </Stack>
      </Surface>

      <Surface flex="1 1 380px" minW="320px" p={4}>
        <Stack gap={4}>
          <HStack justify="space-between" align="start" gap={2}>
            <SectionEyebrow>Publish</SectionEyebrow>
            <SharedTag status={status} />
          </HStack>
          <Box>
            <Button
              size="sm"
              colorPalette="violet"
              fontFamily="heading"
              onClick={onShare}
              loading={publishing}
              disabled={disabled || !reportDone(status) || reportShared(status)}
            >
              <ShareNetwork style={{ marginRight: 4 }} />
              {reportShared(status) ? "Published to parents" : "Publish to parents"}
            </Button>
            <Text fontSize="xs" color="charcoal.300" fontFamily="body" mt={1.5}>
              Publishes the report to the family. Enabled once the report is marked done.
            </Text>
          </Box>
        </Stack>
      </Surface>
    </Flex>
  );
}
