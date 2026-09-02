"use client";

/**
 * ScholarWorkTable — ONE persistent table behind the Homework · Academic Rounds
 * · SEL Rounds tabs. It is mounted once in the Scholars layout with the active
 * tab as a PROP (never a `key`), so switching among the three tabs keeps the
 * grade and name columns mounted and solid — only the per-tab CONTENT cell of
 * each row swaps.
 *
 * DOM-stability story: the table root, the sortable "Grade" header, and each
 * `ScholarWorkRow` (keyed by scholarId) are the SAME element/component types at
 * the SAME positions across all three tabs. A row's anchor `href`, its
 * `aria-label`, and its content-cell CHILDREN change with the tab, but the
 * `<a>`, the grade `<Text>`, and the avatar+name cell do not — so React updates
 * them in place and never unmounts the grade/name columns. Every row is an
 * anchor (Homework selection is expressed as an href to the scholar, the same
 * navigation the old button did), which is what keeps the row root a single
 * stable element type across tabs.
 *
 * Rows are driven by the scoped ROSTER (available immediately, stable across
 * tabs); per-tab data joins onto those rows by scholarId. A roster scholar with
 * no matching Rounds-week row gets a quiet "not in this reporting period" cell,
 * not a missing row.
 */

import { useMemo, useState, type ReactNode } from "react";
import NextLink from "next/link";
import { Box, Button, HStack, Link as ChakraLink, Text } from "@chakra-ui/react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useNow } from "@/hooks/useNow";
import { useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { gradeForAgeFromDob } from "@/components/practice/chronologicalGrade";
import type { RoundsCadenceKind } from "@/lib/roundsCadence";
import {
  RoundsRowContent,
  type WeekScholar,
} from "@/components/rounds/RoundsRowContent";
import type { SelSynthesisRow } from "@/components/rounds/selSynthesisView";
import { useBatchedScholarRows } from "@/components/rounds/useScholarBatches";

import { type Scholar } from "./types";
import {
  HomeworkContent,
  HOMEWORK_PAGE_SIZE,
  type HomeworkPlanRow,
} from "./HomeworkContent";

export type WorkTab = "homework" | "academic-rounds" | "sel-rounds";
type SortDir = "asc" | "desc";
type WeekPayload = FunctionReturnType<typeof api.rounds.week>;

/** Fixed width of the leading "Grade" column, so the header label sits directly
 *  over each row's grade value. */
const GRADE_COL_W = "3rem";
/** Fixed width of the identity column (avatar + name), so grade · identity ·
 *  content are TRUE columns: the content cell's left edge is the same on every
 *  row regardless of name length. The avatar is 2rem + 0.625rem gap, leaving
 *  ~11rem for the name at heading `sm`—comfortably ~24 chars before the
 *  lineClamp ellipsis. Narrower on base so a phone viewport doesn't crush the
 *  content cell (this is a desktop/iPad-first teacher surface). */
const IDENTITY_COL_W = { base: "9.5rem", md: "14rem" };
/** Stable empty roster for the synthesis batch a non-SEL tab does not read. */
const EMPTY_IDS: string[] = [];

export function ScholarWorkTable({
  tab,
  scholars,
  sortDir,
  onToggleSort,
  hrefForScholar,
  week,
  weekKey,
  emptyState,
}: {
  tab: WorkTab;
  /** The scoped roster — the row-set, stable across tab switches. */
  scholars: Scholar[];
  sortDir: SortDir;
  onToggleSort: () => void;
  /** The per-tab navigation target for a row (scholar feed / Rounds pane). */
  hrefForScholar: (scholarId: string) => string;
  /** The `api.rounds.week` payload (Rounds tabs only), undefined while loading. */
  week?: WeekPayload;
  /** The viewed Rounds week key — the SEL synthesis batch key. */
  weekKey?: string | null;
  emptyState?: ReactNode;
}) {
  const rounds = tab !== "homework";
  const sel = tab === "sel-rounds";
  const cadence: RoundsCadenceKind = sel ? "sel" : "academic";

  // T11: one clock read for the whole table, shared by every row's grade — two
  // scholars born a day apart can never straddle a midnight mid-scroll.
  const [mountedAtMs] = useState(() => Date.now());
  const nowDate = useMemo(() => new Date(mountedAtMs), [mountedAtMs]);

  // The rows, sorted client-side by chronological grade-for-age. Ascending =
  // youngest first (lowest grade at the top). A null grade (missing/invalid
  // DOB) sorts LAST in either direction. This is the single ordering for all
  // three tabs (Homework's old newest-active order is gone).
  const rows = useMemo(() => {
    const withGrade = scholars.map((scholar) => ({
      scholar,
      gradeForAge: gradeForAgeFromDob(scholar.dateOfBirth, nowDate),
    }));
    withGrade.sort((a, b) => {
      if (a.gradeForAge === null || b.gradeForAge === null) {
        return a.gradeForAge === b.gradeForAge ? 0 : a.gradeForAge === null ? 1 : -1;
      }
      return sortDir === "asc"
        ? a.gradeForAge - b.gradeForAge
        : b.gradeForAge - a.gradeForAge;
    });
    return withGrade;
  }, [scholars, sortDir, nowDate]);

  // ── Homework content: the windowed, batched read, joined by scholarId ──────
  // The same PAGE_SIZE=20 read-volume bound as the old HomeworkList, one
  // `useQueries` subscription per page. `now` is a coarse live clock (the
  // "was due" phrasing is a live claim), distinct from the grade clock above.
  const minuteNow = Math.floor(useNow(60_000) / 60_000) * 60_000;
  const homeworkPages = useMemo(() => {
    if (tab !== "homework") return [] as string[][];
    const ids = rows.map((r) => r.scholar.id);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += HOMEWORK_PAGE_SIZE) {
      chunks.push(ids.slice(i, i + HOMEWORK_PAGE_SIZE));
    }
    return chunks;
  }, [tab, rows]);
  const homeworkQueries = useMemo(() => {
    const q: Record<
      string,
      {
        query: typeof api.takeHomePlans.forVisibleScholarsAsTeacher;
        args: { scholarIds: Id<"users">[]; now: number };
      }
    > = {};
    homeworkPages.forEach((chunk, i) => {
      q[`p${i}`] = {
        query: api.takeHomePlans.forVisibleScholarsAsTeacher,
        args: { scholarIds: chunk as Id<"users">[], now: minuteNow },
      };
    });
    return q;
  }, [homeworkPages, minuteNow]);
  const homeworkResults = useQueries(homeworkQueries);
  const { homeworkByScholar, homeworkLoadingIds } = useMemo(() => {
    const map = new Map<string, HomeworkPlanRow>();
    const loading = new Set<string>();
    homeworkPages.forEach((chunk, i) => {
      const res = homeworkResults[`p${i}`] as
        | FunctionReturnType<typeof api.takeHomePlans.forVisibleScholarsAsTeacher>
        | undefined
        | Error;
      if (res === undefined) {
        for (const id of chunk) loading.add(id);
      } else if (!(res instanceof Error)) {
        for (const row of res.scholars ?? []) map.set(String(row.scholarId), row);
      }
    });
    return { homeworkByScholar: map, homeworkLoadingIds: loading };
  }, [homeworkPages, homeworkResults]);

  // ── Rounds content: the week payload joined by scholarId ───────────────────
  const weekByScholar = useMemo(() => {
    const m = new Map<string, WeekScholar>();
    if (week && week.configured) {
      for (const ws of week.scholars) m.set(String(ws.scholarId), ws);
    }
    return m;
  }, [week]);

  // The SEL lens reads the weekly synthesis, batched (server fan-out bound) and
  // keyed to the viewed week. Scoped to the VISIBLE rows that are actually in
  // the period, so a rail-narrowed board never fans out over hidden scholars.
  const selIds = useMemo(
    () =>
      sel && week?.configured && weekKey
        ? rows
            .filter((r) => weekByScholar.has(r.scholar.id))
            .map((r) => r.scholar.id)
        : EMPTY_IDS,
    [sel, week, weekKey, rows, weekByScholar],
  );
  const syntheses = useBatchedScholarRows<SelSynthesisRow & { scholarId: string }>(
    api.selSyntheses.forScholarsWeek,
    selIds,
    { weekKey: weekKey ?? "" },
  );
  const synthesesById = syntheses.byId;
  const synthesesLoading = syntheses.loading;

  function contentFor(scholarId: string): ReactNode {
    if (!rounds) {
      return (
        <HomeworkContent
          plan={homeworkByScholar.get(scholarId)}
          planLoading={homeworkLoadingIds.has(scholarId)}
        />
      );
    }
    // Rounds: the week payload is still loading — a light per-cell placeholder,
    // NOT a blanked column.
    if (week === undefined) return <ContentSkeleton />;
    // SEL not configured — the header carries the explanation; the cell reads
    // empty rather than a misleading "not in this period".
    if (!week.configured) return null;
    const ws = weekByScholar.get(scholarId);
    if (!ws) {
      return (
        <Text fontFamily="body" fontSize="xs" color="charcoal.300" fontStyle="italic" lineClamp={1}>
          Not in this reporting period
        </Text>
      );
    }
    return (
      <RoundsRowContent
        scholar={ws}
        cadence={cadence}
        synthesis={synthesesById.get(scholarId) ?? null}
        synthesisLoading={synthesesLoading}
      />
    );
  }

  return (
    // pt=0: the tab bar above owns the gap below itself (DRY spacing rule).
    <Box px={{ base: 4, lg: 8 }} pb={{ base: 5, lg: 8 }} pt={0}>
      <Box maxW="1100px" mx="auto">
        {rows.length === 0 ? (
          emptyState ?? null
        ) : (
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="xl"
            overflow="hidden"
            data-testid={rounds ? "scholar-work-table" : "homework-list"}
          >
            {/* Sortable "Grade" column header — sits over the leading grade
                column; clicking cycles ascending ↔ descending grade-for-age. */}
            <HStack
              px={{ base: 3, md: 4 }}
              py={2}
              gap={3}
              align="center"
              bg="gray.50"
              borderBottomWidth="1px"
              borderColor="gray.200"
              role="row"
            >
              <Box role="columnheader" aria-sort={sortDir === "asc" ? "ascending" : "descending"}>
                <Button
                  variant="ghost"
                  size="sm"
                  px={0}
                  minW="auto"
                  h="auto"
                  gap={1}
                  onClick={onToggleSort}
                  aria-label={`Sort by grade, currently ${sortDir === "asc" ? "ascending — youngest first" : "descending — oldest first"}`}
                  data-testid="rounds-sort-grade"
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="sm"
                  color="charcoal.500"
                >
                  Grade
                  {sortDir === "asc" ? (
                    <CaretUp size={13} weight="bold" />
                  ) : (
                    <CaretDown size={13} weight="bold" />
                  )}
                </Button>
              </Box>
            </HStack>

            {rows.map(({ scholar, gradeForAge }, i) => (
              <ScholarWorkRow
                key={scholar.id}
                scholarId={scholar.id}
                name={scholar.name || "Scholar"}
                image={scholar.image ?? null}
                gradeForAge={gradeForAge}
                href={hrefForScholar(scholar.id)}
                isRounds={rounds}
                ariaLabel={
                  rounds
                    ? `${scholar.name || "Scholar"}${
                        gradeForAge == null ? "" : `, grade for age ${gradeForAge.toFixed(1)}`
                      } — open the full Rounds view.`
                    : `${scholar.name || "Scholar"} — open scholar.`
                }
                topBorder={i > 0}
              >
                {contentFor(scholar.id)}
              </ScholarWorkRow>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// A row is ONE anchor into the scholar. As a real <a> it gets keyboard focus,
// Enter, middle-click and cmd/ctrl-click for a new tab for free — so nothing
// interactive is nested inside it. The element TYPE is identical across tabs;
// only href / aria-label / the content children change. Exported for the
// column-structure unit test (the identity column carries a FIXED width).
export function ScholarWorkRow({
  scholarId,
  name,
  image,
  gradeForAge,
  href,
  isRounds,
  ariaLabel,
  topBorder,
  children,
}: {
  scholarId: string;
  name: string;
  image: string | null;
  gradeForAge: number | null;
  href: string;
  isRounds: boolean;
  ariaLabel: string;
  topBorder: boolean;
  children: ReactNode;
}) {
  return (
    <Box borderTopWidth={topBorder ? "1px" : "0"} borderColor="gray.100">
      <ChakraLink
        asChild
        display="block"
        px={{ base: 3, md: 4 }}
        py={3}
        _hover={{ bg: "gray.50", textDecoration: "none" }}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.400",
          outlineOffset: "-2px",
          bg: "gray.50",
        }}
        transition="background 0.12s ease"
      >
        <NextLink href={href} data-testid={isRounds ? "rounds-row" : undefined} aria-label={ariaLabel}>
          <HStack gap={3} align="center" minW={0}>
            <Text
              w={GRADE_COL_W}
              flexShrink={0}
              fontFamily="body"
              fontSize="sm"
              fontWeight="600"
              color="charcoal.400"
              fontVariantNumeric="tabular-nums"
              data-testid="rounds-grade"
            >
              {gradeForAge == null ? "—" : gradeForAge.toFixed(1)}
            </Text>
            <HStack gap={2.5} w={IDENTITY_COL_W} flexShrink={0} minW={0}>
              <Avatar size="sm" name={name} src={image || undefined} colorKey={scholarId} />
              <Text
                fontFamily="heading"
                fontWeight="700"
                fontSize="sm"
                color="navy.500"
                flex="1"
                minW={0}
                lineClamp={1}
                title={name}
              >
                {name}
              </Text>
            </HStack>
            <Box flex={1} minW={0}>
              {children}
            </Box>
          </HStack>
        </NextLink>
      </ChakraLink>
    </Box>
  );
}

/** A light content-cell placeholder while a Rounds week payload first loads —
 *  the solid grade/name columns never blank behind it. */
function ContentSkeleton() {
  return <Box h="0.85rem" w="55%" bg="gray.100" borderRadius="sm" />;
}
